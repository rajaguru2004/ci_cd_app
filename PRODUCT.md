# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Chosen by the user on 2026-09-29: a standalone service in `ci_cd_app`, on the same stack as
the HRM platform it serves — NestJS API + Next.js UI — deployed with its own Docker Compose
file on the team's machine. It does not live inside the HRM monorepo and does not touch HRM
code.

## Users

Mobile engineers of the FusionHRM team, and only them (confirmed 2026-09-29). They start
builds, watch them, read the failing step's log, fix the code, and decide when a build goes to
Google Play and on which track. Releasing to production is their call; no separate approver.

## Product Purpose

An internal, Bitrise-like pipeline console for the FusionHRM Android app
(`com.fusionapps.fusionhrm`, Flutter). It starts real pipeline runs, shows their live state,
exposes logs and test results, hands over the signed Android App Bundle (AAB), and publishes it
to Google Play. It replaces the Bitrise release path, which stopped when the Bitrise workspace
ran out of credits.

Success: an engineer goes from "start" to "on the Play track" without leaving the console, and
when a run fails they can see which step failed and why from the console alone.

## Positioning

The console runs nothing itself and stores no build state. GitHub Actions executes the pipeline
(checkout, dependencies, tests, AAB) and Fastlane publishes to Google Play; every status,
duration, log line, test count and artifact the console shows is read back from GitHub for
that run. No mocked or simulated states, ever.

## Operating Context

- Mobile repo: `the-reciprocal-solutions/human-resource-management-mobile-ess`, default branch
  `main`. The pipeline is one workflow file (`.github/workflows/release.yml`) in that repo.
- Three ways a run starts, all running the same workflow: the console's start button
  (`workflow_dispatch`), a `release: <notes>` commit on `main` (the team's existing Bitrise-era
  convention), and a `v*` git tag on a `main` commit.
- Google Play tracks: internal, alpha, beta, production. "What's new" text is en-US only,
  500 characters at most.
- The upload keystore and `key.properties` are committed in the mobile repo, so CI signs with
  them. The Play service-account key lives only as a GitHub Actions secret.
- The HRM backend still has `POST /mobile-release` wired to Bitrise; it is out of scope here.

## Capabilities and Constraints

- Android + Google Play only. iOS / App Store is out of scope.
- Real builds and real tests only: analysis, unit and widget tests, optional emulator smoke
  suite, signed AAB, Fastlane upload.
- GitHub publishes a job's full log only when that job finishes; while it runs, the console has
  live step states and durations, and links to GitHub's live log.
- GitHub API rate limits apply (5,000 requests per hour per token).
- One Play release at a time: version codes must strictly increase.
- A proof of concept: the complete end-to-end flow first, no over-engineering.

## Brand Commitments

The user chose "the Fusion HRM look": the console borrows the visual language of the HRM web
console's default preset (`CRM/human-resource-management/apps/frontend/DESIGN.md`) so it reads
as part of the same toolset.

## Evidence on Hand

- Real runs appear only after the workflow lands on the mobile repo's `main` and a GitHub token
  is configured. Until then the console shows setup state, not sample builds.
- No sample, demo or placeholder build data may be shipped in the product.

## Product Principles

1. GitHub is the source of truth: the console shows only what it can re-read for that run.
2. A release is a deliberate act: track, notes and version are visible before it starts.
3. A failure explains itself: the failing step, its log, and what to fix, in one place.
4. One pipeline definition: every trigger runs the same `release.yml`.
