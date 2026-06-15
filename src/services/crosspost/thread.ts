interface Block {
  type: "text" | "code";
  content: string;
}

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let currentBlockLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (!inCodeBlock) {
        // We were in a text block, push it first
        if (currentBlockLines.length > 0) {
          blocks.push({
            type: "text",
            content: currentBlockLines.join("\n")
          });
          currentBlockLines = [];
        }
        inCodeBlock = true;
        currentBlockLines.push(line);
      } else {
        // Ending code block
        currentBlockLines.push(line);
        blocks.push({
          type: "code",
          content: currentBlockLines.join("\n")
        });
        currentBlockLines = [];
        inCodeBlock = false;
      }
    } else {
      currentBlockLines.push(line);
    }
  }

  // Push remaining
  if (currentBlockLines.length > 0) {
    blocks.push({
      type: inCodeBlock ? "code" : "text",
      content: currentBlockLines.join("\n")
    });
  }

  // Now, for text blocks, split them into actual paragraphs (by double newlines)
  const finalBlocks: Block[] = [];
  for (const block of blocks) {
    if (block.type === "code") {
      finalBlocks.push(block);
    } else {
      const paragraphs = block.content.split(/\n\n+/);
      for (const p of paragraphs) {
        if (p.trim()) {
          finalBlocks.push({
            type: "text",
            content: p.trim()
          });
        }
      }
    }
  }

  return finalBlocks;
}

export function splitParagraphIntoSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g);
  if (!matches) return [text];
  return matches.map(s => s.trim()).filter(Boolean);
}

/**
 * Splits a post body into thread chunks according to platform limits.
 * Media (if any) should only be attached to the first chunk.
 * If linkBack is enabled, the url is appended to the last chunk.
 */
export function splitPostIntoThread(
  markdown: string,
  limit: number,
  url: string,
  linkBack: boolean
): string[] {
  const blocks = parseBlocks(markdown);
  const parts: string[] = [];
  let currentPost = "";

  const appendToCurrentPost = (text: string) => {
    if (!currentPost) {
      currentPost = text;
    } else {
      currentPost += "\n\n" + text;
    }
  };

  const flushCurrentPost = () => {
    if (currentPost.trim()) {
      parts.push(currentPost.trim());
      currentPost = "";
    }
  };

  for (const block of blocks) {
    if (block.type === "code") {
      const potential = currentPost ? currentPost + "\n\n" + block.content : block.content;
      if (potential.length <= limit) {
        appendToCurrentPost(block.content);
      } else {
        flushCurrentPost();
        if (block.content.length <= limit) {
          appendToCurrentPost(block.content);
        } else {
          // Split code block line by line
          const lines = block.content.split("\n");
          let currentCode = "";
          for (const line of lines) {
            const fence = "```";
            const potentialCode = currentCode ? currentCode + "\n" + line + "\n" + fence : line + "\n" + fence;
            if (potentialCode.length <= limit) {
              if (!currentCode) {
                currentCode = line;
              } else {
                currentCode += "\n" + line;
              }
            } else {
              if (currentCode) {
                let formattedCode = currentCode;
                if (!formattedCode.startsWith("```")) {
                  formattedCode = "```\n" + formattedCode;
                }
                if (!formattedCode.endsWith("```")) {
                  formattedCode = formattedCode + "\n```";
                }
                parts.push(formattedCode);
              }
              currentCode = "```\n" + line;
            }
          }
          if (currentCode) {
            let formattedCode = currentCode;
            if (!formattedCode.startsWith("```")) {
              formattedCode = "```\n" + formattedCode;
            }
            if (!formattedCode.endsWith("```")) {
              formattedCode = formattedCode + "\n```";
            }
            appendToCurrentPost(formattedCode);
          }
        }
      }
    } else {
      // It's a text block
      const potential = currentPost ? currentPost + "\n\n" + block.content : block.content;
      if (potential.length <= limit) {
        appendToCurrentPost(block.content);
      } else {
        if (block.content.length > limit) {
          const sentences = splitParagraphIntoSentences(block.content);
          for (const sentence of sentences) {
            const potentialSent = currentPost ? currentPost + "\n\n" + sentence : sentence;
            if (potentialSent.length <= limit) {
              appendToCurrentPost(sentence);
            } else {
              flushCurrentPost();
              if (sentence.length <= limit) {
                appendToCurrentPost(sentence);
              } else {
                // Sentence too long, split by characters
                let remaining = sentence;
                while (remaining.length > 0) {
                  const chunk = remaining.slice(0, limit);
                  parts.push(chunk);
                  remaining = remaining.slice(limit);
                }
              }
            }
          }
        } else {
          flushCurrentPost();
          appendToCurrentPost(block.content);
        }
      }
    }
  }

  flushCurrentPost();

  if (linkBack) {
    const linkText = `\n\n🔗 ${url}`;
    if (parts.length > 0) {
      const lastPartIndex = parts.length - 1;
      if (parts[lastPartIndex].length + linkText.length <= limit) {
        parts[lastPartIndex] += linkText;
      } else {
        parts.push(`🔗 ${url}`);
      }
    } else {
      parts.push(`🔗 ${url}`);
    }
  }

  return parts;
}

/** Format markdown chunk to clean plain text for Mastodon while preserving code blocks. */
export function formatChunkForMastodon(md: string): string {
  if (md.startsWith("```") && md.endsWith("```")) {
    return md;
  }
  
  const lines = md.split("\n");
  let inCode = false;
  const processedLines = lines.map(line => {
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      return line;
    }
    if (inCode) {
      return line;
    }
    return line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 $2") // links -> text + url
      .replace(/^#{1,6}\s+/gm, "") // headings
      .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
      .replace(/(\*|_)(.*?)\1/g, "$2") // italic
      .replace(/`([^`]+)`/g, "$1") // inline code
      .replace(/^>\s?/gm, ""); // blockquotes
  });
  
  return processedLines.join("\n").trim();
}
