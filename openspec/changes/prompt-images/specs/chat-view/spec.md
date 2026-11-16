# Spec Delta

## MODIFIED Requirements

### Requirement: Blocks of a prompt
A prompt MAY hold the blocks `text`, `resource_link` and `image`. `initialize` MUST announce `promptCapabilities.image`. The main agent MUST get each link as a Markdown link with its name and its URI, in the order of the blocks, and each image as an image. Each other block type MUST be refused.

Tests: `test/integration.test.mjs`

#### Scenario: A link between two texts
- **WHEN** a prompt holds the text `Read this file:`, a `resource_link` with the name `notes.md` and the URI `file:///project/notes.md`, and the text `and say what it holds.`
- **THEN** the user message is `Read this file:`, `[notes.md](file:///project/notes.md)` and `and say what it holds.` on three lines

#### Scenario: An image
- **WHEN** a prompt holds a text block and an `image` block with the type `image/png`
- **THEN** the model gets the text and the image, and `initialize` announces `promptCapabilities.image`

#### Scenario: An audio block
- **WHEN** a prompt holds an `audio` block
- **THEN** the prompt is refused

## ADDED Requirements

### Requirement: Images in the text of a prompt
A path in the text of a prompt, as `@path` or `![alt](<path>)`, that names an existing PNG, JPEG, GIF or WebP file under the home directory MUST give an image, and the text MUST stay as it is. A prompt MUST have at most 4 images, and an image MUST have at most 4.5 MB of base64. A file that Megachat cannot attach MUST give a note after the text, and the prompt MUST go on.

Tests: `test/prompt-images.test.mjs`

#### Scenario: A screenshot of Air
- **WHEN** the text is `look @/home/u/air/shot.png ![Image](</home/u/air/shot.png>)` and the file exists
- **THEN** the model gets the text and one image

#### Scenario: A missing file
- **WHEN** the text names a PNG file that does not exist
- **THEN** the model gets the text and one note line, and no image

#### Scenario: A file above the limit
- **WHEN** the file holds more than 3,375,000 bytes
- **THEN** the model gets the text and one note line, and no image
