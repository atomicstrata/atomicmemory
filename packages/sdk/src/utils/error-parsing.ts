/**
 * @file Error Parsing Utilities
 *
 * Utilities for parsing and enhancing error messages, particularly for
 * cases where JSON parsing fails due to HTML error responses.
 */

interface FetchedUrl {
  url: string;
  status: number;
  isHtml: boolean;
  content?: string;
}

/**
 * Parse HTML error responses to extract meaningful error information
 */
function parseHtmlError(htmlContent: string, url: string): string {
  try {
    // Create a temporary DOM parser (works in both browser and Node.js contexts)
    const parser = typeof DOMParser !== 'undefined' ? new DOMParser() : null;

    if (parser) {
      const doc = parser.parseFromString(htmlContent, 'text/html');

      // Try to extract error information from common HTML error page patterns
      const errorSources = [
        // Chrome extension error pages
        doc.querySelector('h1')?.textContent,
        doc.querySelector('.error-message')?.textContent,
        doc.querySelector('#error-information')?.textContent,

        // Generic error pages
        doc.querySelector('title')?.textContent,
        doc.querySelector('h2')?.textContent,
        doc.querySelector('.message')?.textContent,

        // Server error pages
        doc.querySelector('pre')?.textContent,
        doc.querySelector('.error')?.textContent,
      ];

      const errorMessage = errorSources
        .filter(Boolean)
        .map(msg => msg?.trim())
        .find(msg => msg && msg.length > 0);

      if (errorMessage) {
        return `HTML Error from ${url}: ${errorMessage}`;
      }
    }

    // Fallback: extract text content using regex
    const titleMatch = htmlContent.match(/<title[^>]*>([^<]+)<\/title>/i);
    const h1Match = htmlContent.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    const bodyTextMatch = htmlContent.match(/<body[^>]*>[\s\S]*?<\/body>/i);

    if (titleMatch?.[1]) {
      return `HTML Error from ${url}: ${titleMatch[1].trim()}`;
    }

    if (h1Match?.[1]) {
      return `HTML Error from ${url}: ${h1Match[1].trim()}`;
    }

    // Extract first meaningful text from body
    if (bodyTextMatch?.[0]) {
      const bodyText = bodyTextMatch[0]
        .replace(/<[^>]+>/g, ' ') // Remove HTML tags
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim()
        .substring(0, 200); // Limit length

      if (bodyText.length > 10) {
        return `HTML Error from ${url}: ${bodyText}...`;
      }
    }

    return `HTML Error from ${url}: Unable to parse error details`;
  } catch (parseError) {
    return `HTML Error from ${url}: Failed to parse HTML (${parseError})`;
  }
}

/**
 * Enhanced error parsing for Transformers.js JSON parsing failures
 */
export function parseTransformersError(
  originalError: Error,
  fetchedUrls: FetchedUrl[]
): Error {
  const errorMessage = originalError.message;

  // Check if this is a JSON parsing error with HTML content
  if (
    errorMessage.includes("Unexpected token '<'") &&
    errorMessage.includes('<!DOCTYPE')
  ) {
    // Find HTML responses that likely caused the error
    const htmlResponses = fetchedUrls.filter(
      ({ isHtml, status }) => isHtml && (status === 404 || status >= 400)
    );

    if (htmlResponses.length > 0) {
      const errorDetails = htmlResponses
        .map(({ url, status, content }) => {
          if (content) {
            return parseHtmlError(content, url);
          }
          return `${status} error from ${url}`;
        })
        .join('; ');

      const enhancedMessage = `JSON parsing failed due to HTML error response(s): ${errorDetails}. Original error: ${errorMessage}`;

      const enhancedError = new Error(enhancedMessage);
      enhancedError.name = originalError.name;
      enhancedError.stack = originalError.stack;
      (enhancedError as any).cause = originalError;

      return enhancedError;
    }
  }

  // For other error types, return original error
  return originalError;
}

/**
 * Fetch URL and capture content for error analysis
 */
async function fetchWithErrorCapture(url: string): Promise<{
  response: Response;
  content?: string;
  isHtml: boolean;
}> {
  try {
    const response = await fetch(url);
    const contentType = response.headers.get('content-type') || '';
    const isHtml = contentType.includes('text/html');

    let content: string | undefined;

    // Capture content for error analysis if it's an error response
    if (!response.ok || isHtml) {
      try {
        content = await response.clone().text();
      } catch (contentError) {
        console.warn(
          `Failed to capture error content from ${url}:`,
          contentError
        );
      }
    }

    return {
      response,
      content,
      isHtml,
    };
  } catch (fetchError) {
    throw new Error(`Failed to fetch ${url}: ${fetchError}`);
  }
}

/**
 * Enhanced fetch interceptor that captures error content
 */
function createEnhancedFetchInterceptor(
  originalFetch: typeof fetch,
  onUrlFetched?: (info: FetchedUrl) => void
): typeof fetch {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    try {
      const { response, content, isHtml } = await fetchWithErrorCapture.call(
        null,
        input as any
      );

      // Report fetch info for debugging
      if (onUrlFetched) {
        onUrlFetched({
          url,
          status: response.status,
          isHtml,
          content:
            content && content.length < 1000
              ? content
              : content?.substring(0, 1000),
        });
      }

      return response;
    } catch (error) {
      // Report failed fetch
      if (onUrlFetched) {
        onUrlFetched({
          url,
          status: -1,
          isHtml: false,
          content: `Fetch failed: ${error}`,
        });
      }

      throw error;
    }
  };
}
