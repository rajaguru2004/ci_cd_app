# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Chosen by the user on 2026-09-29: a standalone service in `ci_cd_app`, on the same stack as
the HRM platform — NestJS API + Next.js UI — deployed with its own Docker Compose file. Since
2026-10-10 a third service, the builder, holds the keys and runs every build.

## Users

Mobile engineers of the organization (confirmed 2026-10-10: "any other user using our
service"), across all of its apps. Each connects the repositories their own git account can
open, starts builds, reads failing logs, and decides when a build goes to Google Play and on
which track. Releasing to production is their call; no separate approver.

## Product Purpose

The organization's release console for its Android apps (Flutter): one place to add an app,
connect its repository, store its upload key and Google Play key once, and then build, test and
release any app with one press. It replaced the Bitrise release path, which stopped when the
Bitrise workspace ran out of credits, and since 2026-10-10 is no longer FusionHRM's alone.

Success: an engineer adds an app in minutes (git email → key → SSH URL → keys), and goes from
"Release" to "on the Play track" without leaving the console; when a run fails, its failing
step and log say why.

## Positioning

Every run executes on this server's builder, or — per app, since 2026-10-10 — on the
repository's own GitHub Actions: git pull over SSH, `flutter` analysis and tests, the AAB,
signing with the app's upload key, Fastlane to Google Play, either way. The console shows only
what was recorded for that run — jobs, steps, live log, test report, AAB, Google Play's answer
— copied back from GitHub when that is where it ran. No mocked or simulated states, ever.

## Operating Context

- Apps live in their own repositories on GitHub, GitLab, Bitbucket or any SSH git server. The
  console reaches them with ed25519 keys it generates per person (named after their git email);
  the person adds the public key to their account or as a deploy key.
- Secrets are written once and never shown again: SSH private keys, upload keystores and their
  passwords, per-app Google Play keys and GitHub tokens live sealed (AES-256-GCM, `VAULT_KEY`)
  in the builder. A key copied to GitHub (for a run there) travels sealed for GitHub's own
  public key and is never read back.
- Google Play tracks: internal, alpha, beta, production. "What's new" is en-US only, 500
  characters at most. Google requires an app's first upload by hand.
- First app: Fusion HRM (`com.fusionapps.fusionhrm`); its nine earlier runs, including the
  internal releases 1007 and 1009, belong to it.

## Capabilities and Constraints

- Android + Google Play only; Flutter projects only (a native Android project is refused with a
  sentence). iOS / App Store is out of scope.
- Where an app builds is a choice, not a fork of the product: the same plan, the same six
  stages, the same signing rule, whichever runner executes it.
- One build at a time on the builder, for all apps on this server; GitHub Actions runs do not
  share that queue (GitHub's own concurrency applies), but two releases of one app uploading to
  Google Play at once are still refused (Google keeps one open edit per app).
- The original GitHub Actions path (`release.yml`, hard-coded to FusionHRM, one console-wide
  token) was retired on 2026-10-10 the same day it was asked for back, generic and per app: SSH
  access is still how the console reaches a repository either way; a GitHub token is only for
  starting and following the app's own workflow.
- One shared console password; keys record whose git email they were made for.
- A proof of concept growing into the team's tool: complete flows first, no over-engineering.

## Brand Commitments

The user chose "the Fusion HRM look" (2026-09-29): the console borrows the visual language of
the HRM web console's default preset (`CRM/human-resource-management/apps/frontend/DESIGN.md`)
so it reads as part of the same toolset. The console's own name is "Release Console"; no app's
identity sits in its chrome.

## Evidence on Hand

- Real apps and runs only. With no app yet, the console shows how to add one, not sample apps.
- No sample, demo or placeholder build data may be shipped in the product.

## Product Principles

1. The run is the record: the console shows only what the builder recorded for that run.
2. A release is a deliberate act: track, notes and source are visible before it starts.
3. A failure explains itself: the failing step, its log, and what to fix, in one place.
4. Keys go in, never out: the browser sees fingerprints and certificates, builds see no key.
5. One pipeline for every app: the same six stages, whatever the app.
