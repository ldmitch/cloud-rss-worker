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
	return (
		content
			.replace(/<!?\[CDATA\[(.*?)\]\]>/gs, "$1")
			// In case there are partial leftovers like “[CDATA[” without the closing,
			// or the parser returned them without exclamation mark:
			.replace(/\[CDATA\[/g, "")
			.replace(/\]\]/g, "")
	);
}

// Helper: Decode HTML entities to their corresponding characters
function decodeHtmlEntities(text: string): string {
	if (!text) return "";

	const entities: { [key: string]: string } = {
		"&amp;": "&",
		"&lt;": "<",
		"&gt;": ">",
		"&quot;": '\"',
		"&apos;": "'",
		"&nbsp;": " ",
		"&ndash;": "–",
		"&mdash;": "—",
		"&lsquo;": "'",
		"&rsquo;": "'",
		"&sbquo;": "‚",
		"&ldquo;": '"',
		"&rdquo;": '"',
		"&bdquo;": "„",
	};

	// Replace named entities
	let result = text;
	Object.keys(entities).forEach((entity) => {
		result = result.replace(new RegExp(entity, "g"), entities[entity]);
	});

	// Replace numeric entities (decimal and hexadecimal)
	return result
		.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Helper: Convert URLs to alphanumeric IDs
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

// Helper: Allow multiple attempts at putting a value to KV with exponential backoff
async function putWithRetries(
	kvNamespace: KVNamespace,
	key: string,
	value: string | ArrayBuffer | ReadableStream,
	maxRetries: number = 3,
	initialDelayMs: number = 200,
	metadata?: unknown,
	expirationTtl?: number,
): Promise<void> {
	let attempts = 0;
	let delay = initialDelayMs;

	while (attempts <= maxRetries) {
		try {
			const options: KVNamespacePutOptions = {};
			if (metadata !== undefined) {
				options.metadata = metadata;
			}
			if (expirationTtl !== undefined) {
				options.expirationTtl = expirationTtl;
			}

			await kvNamespace.put(key, value, options);

			if (attempts > 0) {
				console.log(`KV put successful for key '${key}' after ${attempts} retries.`);
			}
			return;
		} catch (error) {
			attempts++;
			if (attempts > maxRetries) {
				console.error(`KV put failed for key '${key}' after ${maxRetries} retries. Giving up. Last error:`, error);
				throw error;
			}

			console.warn(`KV put failed for key '${key}' (attempt ${attempts}/${maxRetries}). Retrying in ${delay}ms... Error:`, error);

			await new Promise((resolve) => setTimeout(resolve, delay));
			delay *= 2;
		}
	}
}

// Function: Fetch and parse RSS/ATOM feeds
async function fetchAndParseFeed(url: string, sourceName: string): Promise<Article[]> {
	try {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Failed to fetch ${url}: ${response.status}`);
		}
		const xmlText = await response.text();

		const parser = new DOMParser();
		const xmlDoc = parser.parseFromString(xmlText, "text/xml");

		const parserError = xmlDoc.getElementsByTagName("parsererror")[0];
		if (parserError) {
			throw new Error(`Failed to parse XML for ${url}: ${parserError.textContent}`);
		}

		const articles: Article[] = [];

		// Check if this is an RSS feed (has <item> elements)
		const rssItems = xmlDoc.getElementsByTagName("item");
		if (rssItems.length > 0) {
			for (const item of Array.from(rssItems)) {
				// Get data and strip CDATA if present
				const titleText = item.getElementsByTagName("title")[0]?.textContent || "";
				const title = decodeHtmlEntities(stripCDATA(titleText));
				const link = item.getElementsByTagName("link")[0]?.textContent || "";
				const descriptionText = item.getElementsByTagName("description")[0]?.textContent || "";
				const description = decodeHtmlEntities(stripCDATA(descriptionText));
				const pubDate = item.getElementsByTagName("pubDate")[0]?.textContent || "";

				if (link && pubDate) {
					if (isWithinLast48Hours(pubDate)) {
						articles.push({
							id: hashUrl(link),
							url: link,
							title: title || sourceName,
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
				for (const entry of Array.from(atomEntries)) {
					// Get title and strip CDATA if present
					const titleText = entry.getElementsByTagName("title")[0]?.textContent || "";
					const title = decodeHtmlEntities(stripCDATA(titleText));

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
					const content = decodeHtmlEntities(stripCDATA(contentText));
					const summaryText = entry.getElementsByTagName("summary")[0]?.textContent || "";
					const summary = decodeHtmlEntities(stripCDATA(summaryText));
					const description = content || summary;

					const published = entry.getElementsByTagName("published")[0]?.textContent || "";
					const updated = entry.getElementsByTagName("updated")[0]?.textContent || "";
					const pubDate = published || updated;

					if (link && title && pubDate) {
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

// Helper: Check if a publication date is within the last 48 hours
function isWithinLast48Hours(dateString: string): boolean {
	try {
		const pubDate = new Date(dateString);
		const now = new Date();
		const hoursDifference = (now.getTime() - pubDate.getTime()) / (1000 * 60 * 60);
		return hoursDifference <= 48;
	} catch (error) {
		console.error(`Error parsing date: ${dateString}`, error);
		return false;
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
					"Cache-Control": "public, max-age=300, s-maxage=900",
				},
			});
		} catch (error) {
			return new Response(`Error fetching articles: ${error}`, {
				status: 500,
			});
		}
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log("Running scheduled refresh of articles");

		const fetchPromises = sources.map((source) =>
			fetchAndParseFeed(source.url, source.name).catch((error) => {
				console.error(`Scheduled task: Error processing <span class="math-inline">\{source\.name\} \(</span>{source.url})`, error);
				return [] as Article[]; // Ensure failed promises resolve to an empty array
			}),
		);

		const results = await Promise.all(fetchPromises);
		const allArticles = results.flat(); // Flatten the array of arrays

		allArticles.sort((a, b) => {
			try {
				const dateA = new Date(a.publicationDatetime).getTime();
				const dateB = new Date(b.publicationDatetime).getTime();

				if (isNaN(dateA) && isNaN(dateB)) return 0;
				if (isNaN(dateA)) return 1; // Put items with invalid dates last
				if (isNaN(dateB)) return -1;
				return dateB - dateA; // Descending order
			} catch (e) {
				console.error(`Error parsing dates during sort: ${a.publicationDatetime}, ${b.publicationDatetime}`, e);
				return 0; // Keep original order if dates are problematic
			}
		});

		const articlesJson = JSON.stringify(allArticles);
		const currentTimestamp = Math.floor(Date.now() / 1000).toString();

		try {
			// Use putWithRetries for KV writes
			console.log(`Attempting to write ${allArticles.length} articles to KV...`);
			await putWithRetries(env.ARTICLES, "all_articles", articlesJson);

			console.log(`Attempting to write last_update timestamp (${currentTimestamp}) to KV...`);
			await putWithRetries(env.ARTICLES, "last_update", currentTimestamp);

			// Log final success only if both puts succeed after retries
			console.log(`Successfully refreshed ${allArticles.length} articles and updated timestamp at ${new Date().toISOString()}`);
		} catch (error) {
			// This catch block executes if putWithRetries ultimately fails after all attempts
			console.error("Scheduled task failed: Could not write to KV after multiple retries.", error);
			throw error;
		}
	},
} satisfies ExportedHandler<Env>;
