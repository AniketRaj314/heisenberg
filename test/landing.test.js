import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("public landing page describes the product and credits the household", async () => {
  const html = await readFile(new URL("public/index.html", root), "utf8");
  assert.match(html, /Dinner, handled/);
  assert.match(html, /id="how-it-works"/);
  assert.match(html, /id="simulation"/);
  assert.match(html, /id="features"/);
  assert.match(html, /id="under-the-hood"/);
  assert.match(html, /href="https:\/\/aniketraj\.me"[^>]*>Aniket<\/a>/);
  assert.match(html, /href="https:\/\/rushilraj\.me"[^>]*>Rushil<\/a>/);
  assert.match(html, /https:\/\/t\.me\/heisenberg_chef_bot/);
  assert.match(html, /\/assets\/heisenberg-avatar\.jpg/);
  await access(new URL("public/assets/heisenberg-avatar.jpg", root));
});

test("landing page keeps API and MCP security boundaries explicit", async () => {
  const html = await readFile(new URL("public/index.html", root), "utf8");
  const entrypoint = await readFile(new URL("index.js", root), "utf8");
  assert.match(html, /<b>\/api<\/b> BEARER AUTH/);
  assert.match(html, /<b>\/mcp<\/b> SEPARATE TOKEN/);
  assert.match(entrypoint, /app\.get\("\/"/);
  assert.match(entrypoint, /app\.use\("\/api", requireBearerToken/);
  assert.ok(
    entrypoint.indexOf('app.get("/",') <
      entrypoint.indexOf('app.use("/api", requireBearerToken')
  );
});

test("landing page uses external CSS and JavaScript under the site CSP", async () => {
  const html = await readFile(new URL("public/index.html", root), "utf8");
  const styles = await readFile(new URL("public/styles.css", root), "utf8");
  const script = await readFile(new URL("public/script.js", root), "utf8");
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/script\.js"/);
  assert.doesNotMatch(html, /<style\b|<script>(?!\s*<\/script>)/);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(script, /renderScene\("draft"\)/);
});
