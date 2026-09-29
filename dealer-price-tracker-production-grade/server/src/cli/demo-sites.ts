// Serves the three simulated dealer websites locally, so you can try adding competitors and
// running real scrapes without touching anyone's site:
//   node dist/cli/demo-sites.js            (port 4190, or DEMO_SITES_PORT)
// Then add a competitor with start URL http://127.0.0.1:4190/metro-motors/inventory.
// Local addresses are refused by the scraper unless the server runs with SCRAPER_ALLOW_PRIVATE=1.
import { createServer } from "node:http";
import { createMarket } from "../demo/market";
import { renderSite } from "../demo/sites";

const port = Number(process.env.DEMO_SITES_PORT ?? 4190);
const market = createMarket(11, new Date().toISOString().slice(0, 10));

createServer((req, res) => {
  if (req.url === "/robots.txt") return void res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /admin\n");
  const [dealerId, ...rest] = (req.url ?? "/").split("/").filter(Boolean);
  const dealer = market.dealers.find((d) => d.id === dealerId);
  const html = dealer ? renderSite(dealer, "/" + rest.join("/"), `http://${req.headers.host}/${dealerId}`) : null;
  if (html === null) res.writeHead(404).end("not found");
  else res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
}).listen(port, "127.0.0.1", () => console.log(`Demo dealer sites on http://127.0.0.1:${port}/{${market.dealers.map((d) => d.id).join(",")}}/inventory`));
