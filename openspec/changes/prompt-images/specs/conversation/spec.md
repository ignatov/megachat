# Spec Delta

## ADDED Requirements

### Requirement: Images in the model context
The conversation MUST keep the bytes of each image of a prompt. A model request MUST hold only the images of the last 3 user messages that have images. An older image MUST be the text `[image removed from the context]` in the request. A summary MUST name an image as `[image]`.

Tests: `test/prompt-images.test.mjs`

#### Scenario: The fourth image prompt
- **WHEN** the user sends 4 prompts with one image each
- **THEN** the request for the fourth prompt holds 3 images and one placeholder, and the first prompt still holds its image in the conversation
