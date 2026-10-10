import { parseApplicationId, parseManifestLabel, parsePubspec, pickProjectPath } from './project';

describe('parsePubspec', () => {
  it('reads the name, version, build number and the Flutter dependency', () => {
    expect(parsePubspec('name: ess_portal\ndescription: x\nversion: 1.0.1+9\ndependencies:\n  flutter:\n    sdk: flutter\n')).toEqual({
      name: 'ess_portal', versionName: '1.0.1', buildNumber: 9, flutter: true,
    });
    expect(parsePubspec('name: tool\nversion: "2.0.0"\n')).toEqual({ name: 'tool', versionName: '2.0.0', buildNumber: null, flutter: false });
  });
});

describe('parseApplicationId', () => {
  it('reads Groovy and Kotlin DSL, and falls back to the namespace as Gradle does', () => {
    expect(parseApplicationId('android {\n  defaultConfig {\n    applicationId "com.fusionapps.fusionhrm"\n  }\n}')).toBe('com.fusionapps.fusionhrm');
    expect(parseApplicationId('android {\n    namespace = "com.x.y"\n    defaultConfig {\n        applicationId = "com.skillhiveinnovations.nex_hive"\n    }\n}')).toBe('com.skillhiveinnovations.nex_hive');
    expect(parseApplicationId('android {\n    namespace = "com.example.medihive"\n}')).toBe('com.example.medihive');
    expect(parseApplicationId('// applicationId "com.commented.out"\nandroid { namespace = "com.real.one" }\n')).toBe('com.real.one');
    expect(parseApplicationId('android { applicationId = computeId() }')).toBeNull();
  });
});

describe('parseManifestLabel', () => {
  it('reads a spelled-out label and ignores a resource reference', () => {
    expect(parseManifestLabel('<manifest><application\n  android:label="FusionHRM"\n  android:icon="@mipmap/ic_launcher"></application></manifest>')).toBe('FusionHRM');
    expect(parseManifestLabel('<application android:label="@string/app_name">')).toBeNull();
  });
});

describe('pickProjectPath', () => {
  it('takes the shallowest pubspec within two folders, skipping example apps deeper down', () => {
    expect(pickProjectPath(['pubspec.yaml', 'example/pubspec.yaml', 'lib/main.dart'])).toBe('');
    expect(pickProjectPath(['repo-main/pubspec.yaml', 'repo-main/example/pubspec.yaml'])).toBe('repo-main');
    expect(pickProjectPath(['a/b/c/pubspec.yaml'])).toBeNull();
    expect(pickProjectPath(['.dart_tool/pubspec.yaml'])).toBeNull();
  });

  it('honours a configured folder, and only that folder', () => {
    expect(pickProjectPath(['pubspec.yaml', 'apps/mobile/pubspec.yaml'], 'apps/mobile')).toBe('apps/mobile');
    expect(pickProjectPath(['pubspec.yaml'], 'apps/mobile')).toBeNull();
  });
});
