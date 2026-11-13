# Spec Delta

## MODIFIED Requirements

### Requirement: Steps of a release
`npm run release` MUST run `npm run build`, then `npm test` and `npm run test:package`, before it makes the tag. The GitHub release MUST get the file `setup.sh` of the release commit as an asset, so that `https://github.com/ignatov/megachat/releases/latest/download/setup.sh` gives the setup script of the last release (see the capability `setup-script`).

Tests: `test/release.test.mjs`

#### Scenario: The order of the steps
- **WHEN** `npm run release` makes the release `v0.2.1`
- **THEN** it runs `npm run build`, `npm test` and `npm run test:package` in this order, and then it makes the tag, pushes it and makes the GitHub release

#### Scenario: The asset of the setup script
- **WHEN** `npm run release` makes the release `v0.2.1`
- **THEN** `gh release create` gets `setup.sh` as its last argument
