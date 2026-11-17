import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { extractTotpSecretsFromBundle, totpCode, totpSecretBytes } from "../src/sources/spotify/auth.ts";
import { decryptChromiumValue, normalizeCookieInput } from "../src/sources/spotify/cookies.ts";
import { spotifyEpisodeId, spotifySegments } from "../src/sources/spotify/index.ts";

const ID = "3tLsZ2eWZDf7yLNbGVZ3LL";

test("spotify episode ids come from links and URIs, not bare ids", () => {
  assert.equal(spotifyEpisodeId(`https://open.spotify.com/episode/${ID}?si=abc`), ID);
  assert.equal(spotifyEpisodeId(`https://open.spotify.com/intl-ja/episode/${ID}`), ID);
  assert.equal(spotifyEpisodeId(`spotify:episode:${ID}`), ID);
  assert.equal(spotifyEpisodeId(ID), undefined);
  assert.equal(spotifyEpisodeId(`https://open.spotify.com/show/${ID}`), undefined);
});

test("spotify sections become timed sentences; titles and speaker labels are dropped", () => {
  const raw = {
    section: [
      { startMs: 0, title: { title: "Speaker 1" } },
      { startMs: 0, text: { sentence: { startMs: 1000, text: " Hello there. ", highlight: [{ startMs: 1500 }] } } },
      { startMs: 0, title: { title: "Intro" } },
      { startMs: 0, text: { sentence: { startMs: 2000, text: "Second.", highlight: [{ startMs: 9000 }] } } },
      { startMs: 0, text: { sentence: { startMs: 3000, text: "  " } } },
    ],
  };
  assert.deepEqual(spotifySegments(raw), [
    { start: 1, end: 2, text: "Hello there." },
    { start: 2, end: 9.8, text: "Second." },
  ]);
  assert.deepEqual(spotifySegments({}), []);
});

test("totp matches the RFC 6238 SHA-1 vector (truncated to 6 digits)", () => {
  assert.equal(totpCode(Buffer.from("12345678901234567890"), 59_000), "287082");
  assert.equal(totpSecretBytes("ab").toString(), `${97 ^ 9}${98 ^ 10}`);
});

test("totp secrets are read from the web player bundle, newest first", () => {
  const js = `x={secret:'a\\'b',version:7},y={secret:"c\\u0041",version:12}`;
  assert.deepEqual(extractTotpSecretsFromBundle(js), [
    { version: 12, secret: "cA" },
    { version: 7, secret: "a'b" },
  ]);
});

test("sp_dc is taken from cookie headers, JSON, cookies.txt or a bare value", () => {
  assert.equal(normalizeCookieInput("foo=1; sp_dc=AQB; bar=2"), "AQB");
  assert.equal(normalizeCookieInput('{"sp_dc":"AQC"}'), "AQC");
  assert.equal(normalizeCookieInput(".spotify.com\tTRUE\t/\tTRUE\t0\tsp_dc\tAQD\n"), "AQD");
  assert.equal(normalizeCookieInput("  AQE  "), "AQE");
});

test("chromium cookie values decrypt with and without the host digest prefix", () => {
  const key = crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
  const enc = (plain: Buffer) => {
    const c = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    return Buffer.concat([Buffer.from("v10"), c.update(plain), c.final()]);
  };
  const digest = crypto.createHash("sha256").update(".spotify.com").digest();
  assert.equal(decryptChromiumValue(enc(Buffer.from("AQF")), key, ".spotify.com"), "AQF");
  assert.equal(decryptChromiumValue(enc(Buffer.concat([digest, Buffer.from("AQG")])), key, ".spotify.com"), "AQG");
  assert.equal(decryptChromiumValue(Buffer.from("plain"), null, ".spotify.com"), "plain");
});
