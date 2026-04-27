# success-key-once Specification

## Purpose
TBD - created by archiving change success-key-once. Update Purpose after archive.
## Requirements
### Requirement: Warning banner on success page

The success page SHALL display a prominent warning banner telling the user to save their API key immediately, as it will not be shown again after confirmation.

#### Scenario: Warning banner displayed

- **WHEN** the success page loads with a valid API key
- **THEN** a warning banner SHALL be visible above the API key display, with text indicating the key should be saved immediately and will be masked after confirmation

### Requirement: One-time key display with confirmation

The success page SHALL show the full API key on first view. A confirmation button ("I've saved my key") SHALL be provided. After confirmation, the key SHALL be masked everywhere on the page and the Show button SHALL be removed.

#### Scenario: First view shows full key

- **WHEN** the success page loads and the user has not yet confirmed saving the key
- **THEN** the full API key SHALL be displayed, along with a confirmation button

#### Scenario: After confirmation, key is masked

- **WHEN** the user clicks the "I've saved my key" button
- **THEN** the API key SHALL be masked everywhere on the page (key display and Usage Examples)
- **AND** the Show button SHALL be removed
- **AND** the warning banner SHALL be hidden or updated to indicate the key is now masked

#### Scenario: Page refresh within same session

- **WHEN** the user refreshes the success page within the same browser tab/session after confirming
- **THEN** the key SHALL be automatically masked without requiring confirmation again

#### Scenario: New tab allows one more view

- **WHEN** the user opens the success page in a new browser tab (same session)
- **THEN** the full key SHALL be shown again with the warning and confirmation button

### Requirement: Usage Examples key consistency

After confirmation, the API key in Usage Examples SHALL also be masked, consistent with the main key display.

#### Scenario: Usage Examples show full key before confirmation

- **WHEN** the user has not confirmed saving the key
- **THEN** Usage Examples SHALL display the full API key

#### Scenario: Usage Examples show masked key after confirmation

- **WHEN** the user has confirmed saving the key
- **THEN** Usage Examples SHALL display the masked API key (e.g., `sk-xxxx...xxxx`)

