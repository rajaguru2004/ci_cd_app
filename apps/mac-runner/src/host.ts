import type { HostFacts } from './protocol';
import type { Executor } from './executor';

/**
 * What the Mac can do, checked on start, every few minutes, and before each run: macOS, Xcode
 * and its iOS SDK, Flutter, CocoaPods, Ruby and Fastlane, the disk. Each gap is one sentence with
 * the fix, shown on the console's Runners page; a Mac with any gap takes no runs.
 *
 * Steps run with the PATH the Mac user's login shell sets (zsh reads ~/.zprofile and ~/.zshrc:
 * Homebrew, Flutter, rbenv), plus MAC_PATH_PREFIX from the runner's .env.
 */

export interface HostEnv {
  /** The PATH every step gets. */
  path: string;
  home: string;
  user: string;
}

const FALLBACK_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/** The login shell's PATH (zsh on macOS, bash elsewhere), with MAC_PATH_PREFIX first and the usual folders last. */
export async function hostEnv(exec: Executor, prefix: string): Promise<HostEnv> {
  const probe = await exec.exec(
    [
      'if [ -x /bin/zsh ]; then',
      `  p="$(/bin/zsh -lic 'print -r -- "__RC_PATH__\${PATH}__RC_END__"' </dev/null 2>/dev/null)"`,
      'else',
      `  p="$(/bin/bash -lc 'printf "__RC_PATH__%s__RC_END__" "$PATH"' </dev/null 2>/dev/null)"`,
      'fi',
      'printf "%s\\n__RC_HOME__%s__RC_END__\\n__RC_USER__%s__RC_END__\\n" "$p" "$HOME" "$(id -un)"',
    ].join('\n'),
    { timeoutMs: 45_000 },
  );
  if (probe.code !== 0 && !probe.stdout) {
    throw new Error(probe.stderr.trim().split('\n').pop() || `the Mac answered with exit ${probe.code}`);
  }
  const pick = (tag: string) => new RegExp(`__RC_${tag}__([\\s\\S]*?)__RC_END__`).exec(probe.stdout)?.[1] ?? '';
  const parts = [...prefix.split(':'), ...pick('PATH').split(':'), ...FALLBACK_PATH.split(':')].map((p) => p.trim()).filter(Boolean);
  return { path: [...new Set(parts)].join(':'), home: pick('HOME') || '~', user: pick('USER') };
}

/** Every fact in one round trip: key=value lines (newlines inside a value become ' | '). */
const PROBE = `v() { printf '%s=%s\\n' "$1" "$(printf '%s' "$2" | tr '\\n' '|' | sed 's/|/ | /g')"; }
v uname "$(uname -s)"
v arch "$(uname -m)"
v os "$(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null))"
v hostname "$(scutil --get ComputerName 2>/dev/null || hostname)"
v cpu "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
v mem "$(sysctl -n hw.memsize 2>/dev/null)"
v disk "$(df -k "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
v xcode_select "$(xcode-select -p 2>/dev/null)"
v xcode "$(xcodebuild -version 2>&1 | head -n 4)"
v sdk "$(xcrun --sdk iphoneos --show-sdk-version 2>/dev/null)"
v flutter "$(flutter --version --machine 2>/dev/null | tr -d '\\n' | sed -n 's/.*"frameworkVersion"[^"]*"\\([^"]*\\)".*"channel"[^"]*"\\([^"]*\\)".*/\\1 (\\2)/p')"
v flutter_path "$(command -v flutter 2>/dev/null)"
v pod "$(pod --version 2>/dev/null)"
v ruby "$(ruby -e 'print RUBY_VERSION' 2>/dev/null)"
v bundle "$(bundle --version 2>/dev/null)"
v fastlane_path "$(command -v fastlane 2>/dev/null)"
v git "$(git --version 2>/dev/null)"
true`;

function parse(out: string): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) facts[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return facts;
}

const newer = (version: string, than: number[]) => {
  const parts = version.split('.').map(Number);
  for (let i = 0; i < than.length; i += 1) {
    if ((parts[i] ?? 0) !== than[i]) return (parts[i] ?? 0) > than[i];
  }
  return true;
};

/** Checks the Mac; never throws (a Mac that cannot be reached is a fact with a fix). */
export async function probeHost(exec: Executor, prefix: string, user: string): Promise<{ facts: HostFacts; env: HostEnv | null }> {
  const at = new Date().toISOString();
  const empty: HostFacts = {
    checkedAt: at,
    reachable: false,
    os: null,
    arch: null,
    hostname: null,
    cpu: null,
    memoryGb: null,
    diskFreeGb: null,
    xcode: null,
    iosSdk: null,
    flutter: null,
    cocoapods: null,
    ruby: null,
    fastlane: null,
    problems: [],
    ready: false,
  };
  let env: HostEnv;
  try {
    env = await hostEnv(exec, prefix);
  } catch (e) {
    return { facts: { ...empty, problems: [(e as Error).message] }, env: null };
  }
  const res = await exec.exec(PROBE, { env: { PATH: env.path, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }, timeoutMs: 180_000 });
  const f = parse(res.stdout);
  const problems: string[] = [];
  const who = env.user || user || 'the Mac user';
  if (f.uname !== 'Darwin') problems.push(`This host runs ${f.uname || 'an unknown system'}, not macOS: iOS apps build only on a Mac.`);
  const xcode = /Xcode (\S+)[\s|]*Build version (\S+)/.exec(f.xcode ?? '');
  if (/license/i.test(f.xcode ?? '')) problems.push("Xcode's license is not accepted yet: run sudo xcodebuild -license accept on the Mac.");
  else if (!xcode || /CommandLineTools/.test(f.xcode_select ?? '')) {
    problems.push('Xcode is not installed or not selected: install it from the App Store, open it once, then run sudo xcode-select -s /Applications/Xcode.app on the Mac.');
  } else if (!f.sdk) problems.push("Xcode has no iOS SDK: open Xcode once, or run xcodebuild -downloadPlatform iOS on the Mac.");
  if (!f.flutter_path) {
    problems.push(`Flutter is not on the PATH of ${who}'s login shell: install it and add its bin folder to PATH in ~/.zprofile, or set MAC_PATH_PREFIX in the runner's .env.`);
  }
  if (!f.pod) problems.push('CocoaPods is not installed: brew install cocoapods on the Mac.');
  const rubyOk = Boolean(f.ruby && newer(f.ruby, [3, 0]) && f.bundle);
  const fastlane = rubyOk ? `bundler, Ruby ${f.ruby}` : f.fastlane_path ? `on PATH (${f.fastlane_path})` : null;
  if (!fastlane) {
    problems.push(
      `Neither Ruby 3 with bundler${f.ruby ? ` (the Mac has Ruby ${f.ruby})` : ''} nor fastlane is on ${who}'s PATH: brew install ruby and put it on PATH in ~/.zprofile, or brew install fastlane.`,
    );
  }
  const diskFreeGb = f.disk ? Math.round((Number(f.disk) / 1024 / 1024) * 10) / 10 : null;
  if (diskFreeGb !== null && diskFreeGb < 8) problems.push(`Only ${diskFreeGb} GB is free on the Mac; an iOS build needs about 10 GB.`);
  const memoryGb = f.mem ? Math.round((Number(f.mem) / 1024 ** 3) * 10) / 10 : null;
  return {
    facts: {
      checkedAt: at,
      reachable: true,
      os: f.uname === 'Darwin' ? f.os || 'macOS' : f.uname || null,
      arch: f.arch || null,
      hostname: f.hostname || null,
      cpu: f.cpu || null,
      memoryGb: Number.isFinite(memoryGb) ? memoryGb : null,
      diskFreeGb: Number.isFinite(diskFreeGb) ? diskFreeGb : null,
      xcode: xcode ? `Xcode ${xcode[1]} (${xcode[2]})` : null,
      iosSdk: f.sdk ? `iOS ${f.sdk}` : null,
      flutter: f.flutter || (f.flutter_path ? 'installed' : null),
      cocoapods: f.pod || null,
      ruby: f.ruby || null,
      fastlane,
      problems,
      ready: problems.length === 0,
    },
    env,
  };
}
