# release Specification

## Purpose
A release of Megachat is a version tag with a GitHub release. `npm run release` makes a release only from a clean `main` that passed the tests.

## Requirements

### Requirement: Release tag
A release MUST be the tag `v<version>` of the version in `package.json`, and the GitHub release of that tag. The install line MUST select the release with the highest version. It MUST NOT select a pre-release.

Tests: `test/release.test.mjs`

#### Scenario: The tag of the version
- **WHEN** `package.json` has the version `0.2.0` and no release exists
- **THEN** the release is the tag `v0.2.0`

#### Scenario: A pre-release tag and another tag
- **WHEN** the tags `v0.2.0`, `v0.10.0-rc.1` and `vision` exist
- **THEN** the last release is `v0.2.0`

### Requirement: Refused checkouts
`npm run release` MUST refuse a checkout with changes, a branch other than `main`, and a `main` that is not equal to `origin/main`.

Tests: `test/release.test.mjs`

#### Scenario: A checkout with changes
- **WHEN** the checkout has the new file `draft.txt`
- **THEN** `npm run release` fails with "The checkout has changes."

#### Scenario: Another branch
- **WHEN** the branch of the checkout is `topic`
- **THEN** `npm run release` fails with "The branch is topic."

#### Scenario: A commit that origin does not have
- **WHEN** `main` has a commit that `origin/main` does not have
- **THEN** `npm run release` fails with "main is not equal to origin/main."

### Requirement: Refused versions
`npm run release` MUST refuse a version that is not three numbers, a tag that exists in the checkout or in the remote repository, and a version that is not higher than the last release.

Tests: `test/release.test.mjs`

#### Scenario: A pre-release version
- **WHEN** `package.json` has the version `0.4.0-rc.1`
- **THEN** `npm run release` fails, and the error says that the version is not a release version

#### Scenario: A tag that only the remote repository has
- **WHEN** the remote repository has the tag `v0.2.0`, the checkout does not have it, and `package.json` has the version `0.2.0`
- **THEN** `npm run release` fails with "The tag v0.2.0 exists."

#### Scenario: A lower version
- **WHEN** the last release is `v0.3.0` and `package.json` has the version `0.2.5`
- **THEN** `npm run release` fails with "The version 0.2.5 is not higher than the last release v0.3.0."

#### Scenario: A version that is higher as a number
- **WHEN** the last release is `v0.2.0` and `package.json` has the version `0.10.0`
- **THEN** the release is the tag `v0.10.0`

### Requirement: Release notes
The notes of a release MUST be the subjects of the commits since the last release.

Tests: `test/release.test.mjs`

#### Scenario: Two commits since the last release
- **WHEN** the commits "The second behavior" and "The third behavior" came after the release `v0.2.0`
- **THEN** the notes of the next release are these two subjects, one line for each subject

### Requirement: Steps of a release
`npm run release` MUST run `npm run build`, then `npm test` and `npm run test:package`, before it makes the tag.

Tests: `test/release.test.mjs`

#### Scenario: The order of the steps
- **WHEN** `npm run release` makes the release `v0.2.1`
- **THEN** it runs `npm run build`, `npm test` and `npm run test:package` in this order, and then it makes the tag, pushes it and makes the GitHub release

### Requirement: Dry run
`npm run release -- --dry-run` MUST print the release and change nothing.

#### Scenario: A dry run
- **WHEN** `npm run release -- --dry-run` runs in a checkout that can give a release
- **THEN** it prints the tag, the tag of the last release when one exists, and the notes, and it runs no build and no test, and makes no tag, no push and no GitHub release
