# Design

## Decisions

1. **Where the images are made.** The bridge checks the blocks and sends `/input` with `{ requestId, text, images }`.
   An image is `{ mimeType, data }`. The daemon (`PiMegachatService.submit`) finds the images of the text and of the
   links, reads the files, applies the limits, and gives the content parts to `MegachatState.submit`. The daemon reads
   the files, because only it knows the state of the machine. The bridge and the daemon run on one machine.
2. **Fallback paths.** The daemon takes `@<path>` (up to a space) and `![alt](<path>)` or `![alt](path)` from the text,
   and `file:` URIs of links. A path counts only when its real path is a regular file under the home directory of the
   user, with the extension png, jpg, jpeg, gif or webp. The text of the user is the only source: a path in the output
   of a child gives no image.
3. **Limits.** 4 images in one prompt, 4.5 MB of base64 for one image (3,375,000 bytes of the file). A second image
   of the same path in one prompt counts once. An image above the limit, an unreadable file, a missing file and a path
   out of the home directory give one line after the text from `resources/Megachat.properties`
   (`prompt.imageSkipped`). No limit stops the prompt.
4. **Content.** The input is `{ type: 'input', content: [text part, image parts...] }`. Pi Durable allows this form
   (`UserInput` is the content of a user message). Without an image the content stays a string, as before.
5. **Idempotency.** The digest of an input with images is the digest of the text and of the SHA-256 of each image. An
   input without images keeps its old digest, so a state of an older build stays valid.
6. **Storage.** Pi Durable stores the bytes in `conversation.sqlite` with the entry. At most 4 x 4.5 MB for one
   prompt. No new field, so an older state directory needs no migration.
7. **Context.** A hook `beforeRequest` on the generation task replaces the image parts of all user messages but the
   last 3 messages with images by the text `[image removed from the context]`. The rule depends only on the position, so
   the prefix of the prompt cache changes only when a new image arrives. The keep-alive request and the estimate of
   the context size use the same function.
8. **Summary.** The transcript for a summary writes `[image]` for each image of a user message.
9. **Instructions.** `resources/instructions.md` tells the main agent that it sees the images of the user, and that a
   child does not.
10. **View replay.** The chat shows the text of the prompt. A restored chat shows no image.

## Restart

The daemon admits the input in one transaction with its images. A restart continues the turn from the stored entry.

## Files and fields

No new field in `conversation.sqlite`, `settings.json` or another state file. ACP: `agentCapabilities.promptCapabilities.image`
in the answer of `initialize`; no `_meta` key.
