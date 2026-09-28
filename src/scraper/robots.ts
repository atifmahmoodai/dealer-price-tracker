// Minimal robots.txt support: groups, Allow/Disallow with longest-match wins,
// "*" wildcards and "$" anchors, plus Crawl-delay.

interface Rule {
  allow: boolean;
  pattern: RegExp;
  length: number;
}

export interface RobotsPolicy {
  isAllowed(path: string): boolean;
  crawlDelaySeconds?: number;
}

function toRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function parseRobots(text: string, userAgent: string): RobotsPolicy {
  const ua = userAgent.toLowerCase();
  type Group = { agents: string[]; rules: Rule[]; delay?: number };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      if (field === "disallow" && value === "") continue; // "Disallow:" (empty) allows everything
      current.rules.push({ allow: field === "allow", pattern: toRegExp(value), length: value.length });
    } else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }

  // Most specific group: one naming our bot, otherwise "*".
  const token = ua.split(/[\s/]/)[0];
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  const delay = chosen.map((g) => g.delay).find((d) => d !== undefined);

  return {
    crawlDelaySeconds: delay,
    isAllowed(path: string) {
      let best: Rule | null = null;
      for (const r of rules) {
        if (r.pattern.test(path) && (!best || r.length > best.length || (r.length === best.length && r.allow))) best = r;
      }
      return best ? best.allow : true;
    },
  };
}

export const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true };
