/**
 * @file Text Chunking Utilities
 *
 * Text chunking with overlap for optimal embedding generation.
 */

interface ChunkOptions {
  chunkSize: number;
  chunkOverlap: number;
  preserveWords?: boolean;
  separator?: string | RegExp;
  minChunkSize?: number;
}

interface ChunkResult {
  text: string;
  index: number;
  startOffset: number;
  endOffset: number;
  metadata?: {
    wordCount: number;
    charCount: number;
    hasOverlap: boolean;
    [key: string]: unknown;
  };
}

/**
 * Chunks text into overlapping segments for embedding generation
 */
function chunkText(text: string, options: ChunkOptions): string[] {
  const chunks = chunkTextWithMetadata(text, options);
  return chunks.map(chunk => chunk.text);
}

/**
 * Chunks text with detailed metadata about each chunk
 */
export function chunkTextWithMetadata(
  text: string,
  options: ChunkOptions
): ChunkResult[] {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const {
    chunkSize,
    chunkOverlap,
    preserveWords = true,
    separator = ' ',
    minChunkSize: rawMinChunk = Math.floor(chunkSize * 0.1),
  } = options;

  const minChunkSize = Math.max(1, Math.min(rawMinChunk, chunkSize));

  if (chunkSize <= 0 || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error(
      'Invalid chunk options: chunkSize must be positive and chunkOverlap must be less than chunkSize'
    );
  }

  const chunks: ChunkResult[] = [];

  if (text.length <= chunkSize) {
    // Text fits in a single chunk
    return [
      {
        text: text.trim(),
        index: 0,
        startOffset: 0,
        endOffset: text.length,
        metadata: {
          wordCount: text.split(/\s+/).filter(w => w.length > 0).length,
          charCount: text.length,
          hasOverlap: false,
        },
      },
    ];
  }

  let currentOffset = 0;
  let chunkIndex = 0;

  while (currentOffset < text.length) {
    let endOffset = Math.min(currentOffset + chunkSize, text.length);
    let chunkText = text.substring(currentOffset, endOffset);

    // Preserve word boundaries if requested
    if (preserveWords && endOffset < text.length) {
      let lastSeparatorIndex = -1;
      if (separator instanceof RegExp) {
        // Find last regex match index within chunkText
        const matches = [...chunkText.matchAll(separator)];
        if (matches.length > 0) {
          const last = matches[matches.length - 1];
          lastSeparatorIndex = (last.index ?? -1) + (last[0]?.length ?? 0) - 1;
        }
      } else {
        lastSeparatorIndex = chunkText.lastIndexOf(separator);
      }

      if (lastSeparatorIndex > minChunkSize) {
        endOffset = currentOffset + lastSeparatorIndex;
        chunkText = text.substring(currentOffset, endOffset);
      }
    }

    chunkText = chunkText.trim();

    if (chunkText.length >= minChunkSize) {
      chunks.push({
        text: chunkText,
        index: chunkIndex,
        startOffset: currentOffset,
        endOffset: endOffset,
        metadata: {
          wordCount: chunkText.split(/\s+/).filter(w => w.length > 0).length,
          charCount: chunkText.length,
          hasOverlap: chunkIndex > 0,
        },
      });
      chunkIndex++;
    }

    // Calculate next offset with overlap
    const nextOffset = endOffset - chunkOverlap;

    if (nextOffset <= currentOffset) {
      // Prevent infinite loop
      currentOffset = endOffset;
    } else {
      currentOffset = nextOffset;
    }

    // Break if we've reached the end
    if (endOffset >= text.length) {
      break;
    }
  }

  return chunks;
}

/**
 * Chunks text by sentences with overlap
 */
function chunkBySentences(
  text: string,
  maxSentences: number,
  overlapSentences: number = 1
): string[] {
  if (!text || typeof text !== 'string') {
    return [];
  }

  // Simple sentence splitting (can be enhanced with more sophisticated NLP)
  const sentences = text
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (sentences.length <= maxSentences) {
    return [text];
  }

  const chunks: string[] = [];
  let currentIndex = 0;

  while (currentIndex < sentences.length) {
    const endIndex = Math.min(currentIndex + maxSentences, sentences.length);
    const chunkSentences = sentences.slice(currentIndex, endIndex);

    if (chunkSentences.length > 0) {
      chunks.push(chunkSentences.join('. ') + '.');
    }

    currentIndex = endIndex - overlapSentences;

    if (currentIndex <= 0 || endIndex >= sentences.length) {
      break;
    }
  }

  return chunks;
}

/**
 * Chunks text by paragraphs with overlap
 */
function chunkByParagraphs(
  text: string,
  maxParagraphs: number,
  overlapParagraphs: number = 0
): string[] {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  if (paragraphs.length <= maxParagraphs) {
    return [text];
  }

  const chunks: string[] = [];
  let currentIndex = 0;

  while (currentIndex < paragraphs.length) {
    const endIndex = Math.min(currentIndex + maxParagraphs, paragraphs.length);
    const chunkParagraphs = paragraphs.slice(currentIndex, endIndex);

    if (chunkParagraphs.length > 0) {
      chunks.push(chunkParagraphs.join('\n\n'));
    }

    currentIndex = endIndex - overlapParagraphs;

    if (currentIndex <= 0 || endIndex >= paragraphs.length) {
      break;
    }
  }

  return chunks;
}
