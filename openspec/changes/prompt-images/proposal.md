# Proposal

## Why

On 2026-11-16 the author attached a screenshot in the chat of Air. The main agent got only text:
`... @/Users/.../air/prompt-attachments/AIR_Screenshot_2026-11-16_20-36-20.png ![Image](</Users/.../AIR_Screenshot_2026-11-16_20-36-20.png>)`.
The agent could not see the image.

The cause: `initialize` of Megachat gives no `promptCapabilities`. So Air does not send an `image` block. It writes the
attachment into the text, as `@path` and as a Markdown image. Megachat refuses an `image` block, and the main agent has
no tool that reads the file.

The author asked: "support the image link in the chat, read the log and fix it".

## What Changes

Where it shows: the chat. The ACP extension `promptCapabilities` changes. Air needs no change: it sends an `image`
block when the agent announces the capability, and it keeps the text form for an agent that does not.

- `initialize` announces `agentCapabilities.promptCapabilities.image: true`.
- The prompt accepts `image` blocks (base64 `data` and `mimeType`). Also a `resource_link` with an image MIME type, or a
  `file:` URI with an image extension, gives an image.
- Fallback for the text form: an `@path` or a Markdown image `![..](<path>)` in the text of the user, that names an
  existing PNG, JPEG, GIF or WebP file under the home directory of the user, gives an image. The text stays as it is.
- Limits: at most 4 images in one prompt, at most 4.5 MB of base64 for one image (the limit of the tool `read` of Pi
  Durable). A missing, unreadable, too large or other file gives a short note after the text, and the prompt goes on.
- Context: only the images of the last 3 prompts that hold images go to the model. An older image is a text
  placeholder in the request. The conversation keeps the bytes. A summary names an image as `[image]`.

## Capabilities

### Modified Capabilities

chat-view, conversation

## Out of scope

- Downscale of a large image. It is skipped with a note.
- Images for a child agent. A child gets the text of the prompt that the main agent writes.
- `embeddedContext`, audio and other block types.

## Air side

None. A change of the `promptCapabilities` field is in `docs/air-contract.md`.
