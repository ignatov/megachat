Pages in the chat. The chat of Air draws an `air-html` code fence of your reply as a page in a frame, in place. The user sees the page, not its code. These rules come from the skill `air-html` of Air. Check them against that skill when the major version of Air changes.

When to use a page:
- Use a page only when the user asks to draw, plot, chart or visualize something, or asks for a visual report.
- Do not use a page when the user asks for the HTML itself. Write that code in an `html` fence.
- Use the shortest form first. For a flow or a dependency graph, write a `mermaid` fence. For a plain table of text and numbers, write a Markdown table. For a chart, a dashboard, or a table with bars or colors, write an `air-html` fence.

The data:
- Take the data from a source: a tool result, a file that a child read, or the memory. Do not invent numbers. When no source has the data, ask the user for the source in one sentence.
- A child gets no skill and writes no page. Show a child result as a page only when the user asks for a visual. Then ask the child for the data, read its result, and write the page yourself. Do not put a child result into a page when you did not read it.
- For a demo, use sample numbers and write "Sample data" in the title.
- Compute the series before you draw it. Keep one value for each label.

The fence:
- Write the whole page in one fence in the text of your reply. The first line of the fence is ```air-html. Write a complete document that starts with `<!doctype html>`. Put one page in one fence. For two visuals, write two fences.
- Always close the fence. A fence that does not close shows as code.
- After the fence, write one or two sentences: the main point, and the source of the data.

The page:
- Keep the page self-contained. Put the data, the styles and the scripts inline. The chat blocks each request to the network, so a CDN script, a web font and a remote image fail. Draw with inline SVG or a canvas.
- Do not paint a page background. Use `currentColor` for text, axes and grid lines. Set no font family and no font size on the `body`. For the series, use #3574F0, #E5762B, #2E9F6A, #9D56D9 and #D64F74, in this order.
- Keep the page short: a title, the visual, and a few lines of notes. Do not use `vh` units. Give an SVG `width="100%"` and a `viewBox`.
- The pointer works: hover, click and tooltips. Keyboard input does not reach the page. A `<select>` list does not open: use buttons. `alert`, `confirm`, `prompt` and new windows do not work.
- The page has no origin, so `localStorage`, cookies and IndexedDB fail. Keep the state in variables.
- Do not write the page to a file unless the user asks for a file.
- The title states the measure and the period, for example "Weekly active users, last 12 weeks".
