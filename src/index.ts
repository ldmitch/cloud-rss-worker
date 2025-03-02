import type { ScheduledController } from "@cloudflare/workers-types";
import { DOMParser } from "@xmldom/xmldom";
import sourcesData from "../test-sources.json";

interface Article {
  id: string;
  url: string;
  title: string;
  snippet: string;
  source: string;
  publicationDatetime: string;
}

interface Source {
  title: string;
  url: string;
}

const sources = sourcesData.sources.map((source: Source) => ({
  name: source.title,
  url: source.url
}));

// Simple hash function to convert URLs to alphanumeric IDs
function hashUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Convert to alphanumeric string
  return Math.abs(hash).toString(36);
}

// Function to fetch and parse RSS feeds
async function fetchAndParseRSS(url: string, sourceName: string): Promise<Article[]> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }
    const xmlText = await response.text();

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");

    // Check for parsing errors
    const parserError = xmlDoc.getElementsByTagName("parsererror")[0];
    if (parserError) {
      throw new Error(`Failed to parse XML for ${url}: ${parserError.textContent}`);
    }

    const items = xmlDoc.getElementsByTagName("item");
    const articles: Article[] = [];

    for (const item of Array.from(items)) {
      const title = item.getElementsByTagName("title")[0]?.textContent || "";
      const link = item.getElementsByTagName("link")[0]?.textContent || "";
      const description = item.getElementsByTagName("description")[0]?.textContent || "";
      const pubDate = item.getElementsByTagName("pubDate")[0]?.textContent || "";

      if (link && title && pubDate) {
        // Only include articles from the last 36 hours
        if (isWithinLast36Hours(pubDate)) {
          articles.push({
            id: hashUrl(link),
            url: link,
            title,
            snippet: description,
            source: sourceName,
            publicationDatetime: pubDate,
          });
        }
      }
    }

    return articles;

  } catch (error) {
    console.error(`Error processing ${sourceName} (${url}):`, error);
    return []; // Return empty array on failure to continue processing other sources
  }
}

// Check if a publication date is within the last 36 hours
function isWithinLast36Hours(dateString: string): boolean {
  try {
    const pubDate = new Date(dateString);
    const now = new Date();
    const hoursDifference = (now.getTime() - pubDate.getTime()) / (1000 * 60 * 60);
    return hoursDifference <= 36;
  } catch (error) {
    console.error(`Error parsing date: ${dateString}`, error);
    return false; // If we can't parse the date, exclude the article
  }
}

export default {
  // HTTP request handler
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Get articles from KV
    try {
      const articlesString = await env.ARTICLES.get("all_articles");

      if (!articlesString) {
        return new Response("No articles found. The scheduled task may not have run yet.", {
          status: 404
        });
      }

      const articles = JSON.parse(articlesString);
      return new Response(JSON.stringify(articles), {
        headers: {
          "Content-Type": "application/json"
        }
      });
    } catch (error) {
      return new Response(`Error fetching articles: ${error}`, {
        status: 500
      });
    }
  },

  // Scheduled function handler
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    console.log("Running scheduled refresh of articles");

    const allArticles: Article[] = [];
    for (const source of sources) {
      const articles = await fetchAndParseRSS(source.url, source.name);
      allArticles.push(...articles);
    }

    // Sort articles by publication date (newest first)
    allArticles.sort((a, b) => {
      const dateA = new Date(a.publicationDatetime).getTime();
      const dateB = new Date(b.publicationDatetime).getTime();
      return dateB - dateA;
    });

    // Store articles in KV
    await env.ARTICLES.put("all_articles", JSON.stringify(allArticles));

    console.log(`Successfully refreshed ${allArticles.length} articles`);
  },
} satisfies ExportedHandler<Env>;
