const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const sources = {
  makerworld: {
    name: 'MakerWorld',
    searchUrl: (q) => `https://makerworld.com/en/search/models?keyword=${encodeURIComponent(q)}`,
  },
  printables: {
    name: 'Printables',
    searchUrl: (q) => `https://www.printables.com/search/models?q=${encodeURIComponent(q)}`,
  },
  thingiverse: {
    name: 'Thingiverse',
    searchUrl: (q) => `https://www.thingiverse.com/search?q=${encodeURIComponent(q)}&type=things&sort=relevant`,
  },
};

const headers = { 'user-agent': 'Print Scout model search', accept: 'application/json,text/html;q=0.9,*/*;q=0.8' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=120' } });
const unique = (values) => [...new Set(values)];

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).hostname}`);
  return response.json();
}

async function fetchHtml(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).hostname}`);
  return response.text();
}

function fallback(source, query) {
  const config = sources[source];
  return { source, url: config.searchUrl(query), title: `Search ${config.name} for “${query}”`, description: 'Open the library to view its live results.', image: '', metricValue: null, metricLabel: '' };
}

function interleave(groups) {
  const order = ['makerworld', 'printables', 'thingiverse'];
  const available = order.map((name) => groups[name]).filter((group) => !group.unavailable);
  const smallestPage = Math.min(...available.map((group) => group.items.length));
  for (const name of order) if (!groups[name].paginated && !groups[name].unavailable) groups[name].items = groups[name].items.slice(0, smallestPage);
  const results = [];
  for (let index = 0; index < Math.max(...order.map((name) => groups[name].items.length)); index += 1) for (const name of order) if (groups[name].items[index]) results.push(groups[name].items[index]);
  return results;
}

async function makerworld(query) {
  const params = new URLSearchParams({ orderBy: 'score', designType: '0', isFromSearchList: 'false', keyword: query, limit: '20', offset: '0' });
  const data = await fetchJson(`https://makerworld.com/api/v1/search-service/select/design2?${params}`, { headers: { 'x-bbl-app-source': 'makerworld', 'x-bbl-client-name': 'MakerWorld', 'x-bbl-client-type': 'web', 'x-bbl-client-version': '00.00.00.01' } });
  return { paginated: true, items: (data.hits || []).map((model) => ({
    source: 'makerworld', url: `https://makerworld.com/en/models/${model.id}${model.slug ? `-${model.slug}` : ''}`,
    title: model.titleTranslated || model.title,
    description: [model.designCreator?.name && `By ${model.designCreator.name}`, ...(model.tags || []).slice(0, 3)].filter(Boolean).join(' · ') || 'Open this model for details and print files.',
    image: model.cover || model.coverLandscape || model.coverPortrait,
    metricValue: model.downloadCount ?? model.likeCount,
    metricLabel: model.downloadCount != null ? 'downloads' : model.likeCount != null ? 'likes' : '',
  })) };
}

async function printables(query) {
  const gql = 'query SearchModels($query:String!,$limit:Int,$ordering:SearchChoicesEnum){result:searchPrints2(query:$query,printType:print,limit:$limit,ordering:$ordering){items{id name slug likesCount downloadCount user{publicUsername} image{filePath}}}}';
  const data = await fetchJson('https://api.printables.com/graphql/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'SearchModels', query: gql, variables: { query, limit: 20, ordering: 'best_match' } }) });
  return { paginated: true, items: (data.data?.result?.items || []).map((model) => ({
    source: 'printables', url: `https://www.printables.com/model/${model.id}-${model.slug}`, title: model.name,
    description: model.user?.publicUsername ? `By ${model.user.publicUsername}` : 'Open this model for details and print files.',
    image: model.image?.filePath ? `https://media.printables.com/${model.image.filePath.replace(/^\//, '')}` : '',
    metricValue: model.downloadCount ?? model.likesCount,
    metricLabel: model.downloadCount != null ? 'downloads' : model.likesCount != null ? 'likes' : '',
  })) };
}

function meta(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i'));
  return match?.[1] || match?.[2] || '';
}

function count(html, names) {
  for (const name of names) { const match = html.match(new RegExp(`(?:"|\\\\")${name}(?:"|\\\\")\\s*:\\s*(\\d+)`, 'i')); if (match) return Number(match[1]); }
  return null;
}

async function thingDetails(url) {
  const html = await fetchHtml(url);
  const downloads = count(html, ['download_count', 'downloadCount']);
  const likes = count(html, ['like_count', 'likeCount', 'likesCount']);
  return { source: 'thingiverse', url, title: meta(html, 'og:title') || meta(html, 'twitter:title'), description: meta(html, 'og:description') || meta(html, 'description'), image: meta(html, 'og:image') || meta(html, 'twitter:image'), metricValue: downloads ?? likes, metricLabel: downloads != null ? 'downloads' : likes != null ? 'likes' : '' };
}

async function thingiverse(query) {
  const html = await fetchHtml(sources.thingiverse.searchUrl(query));
  const urls = unique([...html.matchAll(/href=["'](\/thing:\d+)["']/gi)].map((match) => new URL(match[1], 'https://www.thingiverse.com').href));
  const items = (await Promise.allSettled(urls.map(thingDetails))).filter((result) => result.status === 'fulfilled').map((result) => result.value);
  return { paginated: /(?:rel=["']next|aria-label=["'][^"']*next|[?&]page=\d+)/i.test(html), items };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname !== '/api/search') return json({ error: 'Not found' }, 404);
    const query = url.searchParams.get('q')?.trim();
    if (!query) return json({ error: 'Enter a search term.' }, 400);
    const settled = await Promise.allSettled([makerworld(query), printables(query), thingiverse(query)]);
    const names = ['makerworld', 'printables', 'thingiverse'];
    const groups = Object.fromEntries(names.map((name, index) => [name, settled[index].status === 'fulfilled' && settled[index].value.items.length ? settled[index].value : { paginated: false, unavailable: true, items: [fallback(name, query)] }]));
    return json({ results: interleave(groups), failures: names.filter((_, index) => settled[index].status === 'rejected') });
  },
};
