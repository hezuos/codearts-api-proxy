## MODIFIED Requirements

### Requirement: Encryption key mandatory in production

The system SHALL require the `ENCRYPTION_KEY` environment variable in production mode and SHALL NOT fall back to a hardcoded default. When the variable is missing, the error message SHALL include actionable guidance explaining the variable's purpose, how to generate a suitable value, and how to set it.

#### Scenario: Production without ENCRYPTION_KEY

- **WHEN** `NODE_ENV=production` and `ENCRYPTION_KEY` is not set
- **THEN** the system SHALL fail to start with an error message that includes:
  - A description of what `ENCRYPTION_KEY` is used for
  - A command to generate a suitable key
  - Instructions on how to set the environment variable

#### Scenario: Development without ENCRYPTION_KEY

- **WHEN** `NODE_ENV=development` and `ENCRYPTION_KEY` is not set
- **THEN** the system SHALL use a development-only default key with a startup warning
