import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootNoticeUrl = new URL("../THIRD_PARTY_NOTICES.md", import.meta.url);
const bundleNoticeUrl = new URL(
  "../works.kawaii.codex-shortcuts-plugin.sdPlugin/THIRD_PARTY_NOTICES.md",
  import.meta.url
);
const rootLicenseUrl = new URL("../LICENSE", import.meta.url);
const bundleLicenseUrl = new URL(
  "../works.kawaii.codex-shortcuts-plugin.sdPlugin/LICENSE",
  import.meta.url
);

test("root and distributed third-party notices stay identical", async () => {
  const [rootNotice, bundleNotice] = await Promise.all([
    readFile(rootNoticeUrl, "utf8"),
    readFile(bundleNoticeUrl, "utf8")
  ]);

  assert.equal(bundleNotice, rootNotice);
});

test("distributed third-party notices name every bundled npm dependency", async () => {
  const notice = await readFile(bundleNoticeUrl, "utf8");
  const requiredPackages = [
    "@elgato/streamdeck",
    "@elgato/schemas",
    "@elgato/utils",
    "ws",
    "zod"
  ];

  for (const packageName of requiredPackages) {
    assert.match(notice, new RegExp(`^## ${escapeRegExp(packageName)}(?: |$)`, "m"));
  }
});

test("root and distributed freeware licenses stay identical", async () => {
  const [rootLicense, bundleLicense] = await Promise.all([
    readFile(rootLicenseUrl, "utf8"),
    readFile(bundleLicenseUrl, "utf8")
  ]);

  assert.equal(bundleLicense, rootLicense);
});

test("freeware license states the grant, restrictions, ownership, and termination", async () => {
  const license = await readFile(bundleLicenseUrl, "utf8");
  const normalizedLicense = license.replace(/\s+/g, " ");

  for (const requiredTerm of [
    "KAWAII Freeware License",
    "Copyright (c) 2026 KAWAII. All rights reserved.",
    "free of charge",
    "personal use",
    "internal use within your organization",
    "install, and use an unmodified copy",
    "commercially distribute",
    "repackage",
    "mirror",
    "sublicense",
    "modify",
    "applicable law does not permit KAWAII to limit or exclude",
    "KAWAII retains all right, title, and interest",
    "THIRD_PARTY_NOTICES.md",
    "WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND",
    "terminates automatically"
  ]) {
    assert.match(normalizedLicense, new RegExp(escapeRegExp(requiredTerm), "i"));
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
