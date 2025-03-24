import type { ScheduledController } from "@cloudflare/workers-types";
import { DOMParser } from "@xmldom/xmldom";
import sourcesData from "../sources.json";

interface Article {
	id: string;
	url: string;
	title: string;
	snippet: string;
	source: string;
	sourceUrl: string;
	publicationDatetime: string;
}

interface Source {
	title: string;
	url: string;
}

const sources = sourcesData.sources.map((source: Source) => ({
	name: source.title,
	url: source.url,
}));

// Helper: Strip CDATA wrappers from a string
function stripCDATA(content: string): string {
	// Remove any opening "<![CDATA[" or "[CDATA[" and the corresponding closing "]]>" or "]]"
	// capturing the inside as group $1 and returning it (so you keep just the inside).
	// The 's' (dotAll) flag ensures the dot also matches newlines.
	// The 'g' flag removes ALL occurrences in one pass.
	return (
		content
			.replace(/<!?\[CDATA\[(.*?)\]\]>/gs, "$1")
			// In case there are partial leftovers like “[CDATA[” without the closing,
			// or the parser returned them without exclamation mark:
			.replace(/\[CDATA\[/g, "")
			.replace(/\]\]/g, "")
	);
}

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

// Function to fetch and parse RSS/ATOM feeds
async function fetchAndParseFeed(url: string, sourceName: string): Promise<Article[]> {
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

		const articles: Article[] = [];

		// Check if this is an RSS feed (has <item> elements)
		const rssItems = xmlDoc.getElementsByTagName("item");
		if (rssItems.length > 0) {
			// Process as RSS feed
			for (const item of Array.from(rssItems)) {
				// Get title and strip CDATA if present
				const titleText = item.getElementsByTagName("title")[0]?.textContent || "";
				const title = stripCDATA(titleText);
				const link = item.getElementsByTagName("link")[0]?.textContent || "";
				const descriptionText = item.getElementsByTagName("description")[0]?.textContent || "";
				const description = stripCDATA(descriptionText);
				const pubDate = item.getElementsByTagName("pubDate")[0]?.textContent || "";

				if (link && title && pubDate) {
					// Only include articles from the last 48 hours
					if (isWithinLast48Hours(pubDate)) {
						articles.push({
							id: hashUrl(link),
							url: link,
							title,
							snippet: description,
							source: sourceName,
							sourceUrl: url,
							publicationDatetime: pubDate,
						});
					}
				} else {
					console.log(`Skipping article with missing fields: ${title} (${url})`);
				}
			}
		} else {
			// Check if this is an ATOM feed (has <entry> elements)
			const atomEntries = xmlDoc.getElementsByTagName("entry");
			if (atomEntries.length > 0) {
				// Process as ATOM feed
				for (const entry of Array.from(atomEntries)) {
					// Get title and strip CDATA if present
					const titleText = entry.getElementsByTagName("title")[0]?.textContent || "";
					const title = stripCDATA(titleText);

					// In ATOM, find the appropriate link (prefer alternate)
					let link = "";
					const linkElements = entry.getElementsByTagName("link");

					// First try to find link with rel="alternate"
					for (const linkElement of Array.from(linkElements)) {
						const rel = linkElement.getAttribute("rel");
						if (rel === "alternate" || !rel) {
							link = linkElement.getAttribute("href") || "";
							break;
						}
					}

					// If no alternate link found, use the first link
					if (!link && linkElements[0]) {
						link = linkElements[0].getAttribute("href") || "";
					}

					// Content could be in content or summary elements
					const contentText = entry.getElementsByTagName("content")[0]?.textContent || "";
					const content = stripCDATA(contentText);
					const summaryText = entry.getElementsByTagName("summary")[0]?.textContent || "";
					const summary = stripCDATA(summaryText);
					const description = content || summary;

					// ATOM uses <published> or <updated> instead of pubDate
					const published = entry.getElementsByTagName("published")[0]?.textContent || "";
					const updated = entry.getElementsByTagName("updated")[0]?.textContent || "";
					const pubDate = published || updated;

					if (link && title && pubDate) {
						// Only include articles from the last 48 hours
						if (isWithinLast48Hours(pubDate)) {
							articles.push({
								id: hashUrl(link),
								url: link,
								title,
								snippet: description,
								source: sourceName,
								sourceUrl: url,
								publicationDatetime: pubDate,
							});
						}
					} else {
						console.log(`Skipping article with missing fields: ${title} (${url})`);
					}
				}
			}
		}

		return articles;
	} catch (error) {
		console.error(`Error processing ${sourceName} (${url}):`, error);
		return []; // Return empty array on failure to continue processing other sources
	}
}

// Check if a publication date is within the last 48 hours
function isWithinLast48Hours(dateString: string): boolean {
	try {
		const pubDate = new Date(dateString);
		const now = new Date();
		const hoursDifference = (now.getTime() - pubDate.getTime()) / (1000 * 60 * 60);
		return hoursDifference <= 48;
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
					status: 404,
				});
			}

			const articles = JSON.parse(articlesString);
			return new Response(JSON.stringify(articles), {
				headers: {
					"Content-Type": "application/json",
				},
			});
		} catch (error) {
			return new Response(`Error fetching articles: ${error}`, {
				status: 500,
			});
		}
	},

	// Scheduled function handler
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log("Running scheduled refresh of articles");

		const allArticles: Article[] = [];
		for (const source of sources) {
			const articles = await fetchAndParseFeed(source.url, source.name);
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

		// Store last update timestamp in KV
		const currentTimestamp = Math.floor(Date.now() / 1000).toString(); // Unix timestamp in seconds
		await env.ARTICLES.put("last_update", currentTimestamp);

		console.log(`Successfully refreshed ${allArticles.length} articles at ${new Date().toISOString()}`);
	},
} satisfies ExportedHandler<Env>;
