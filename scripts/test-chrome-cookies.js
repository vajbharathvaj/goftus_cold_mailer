const { checkChromeCookieAvailability, getChromeCookiesForUrl } = require("../src/services/chromeCookieService");

async function main() {
  console.log("\n-- Chrome Cookie Extraction Test --\n");

  const status = checkChromeCookieAvailability();
  if (!status.available) {
    console.error(`x Not available: ${status.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log("ok Cookie DB and Local State found\n");

  const testUrl = process.argv[2] || "https://google.com";
  console.log(`Testing cookie extraction for: ${testUrl}\n`);

  try {
    const cookies = await getChromeCookiesForUrl(testUrl);
    const count = cookies
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean).length;
    console.log(`ok Extracted ${count} cookies`);
    console.log(`Preview: ${cookies.slice(0, 100)}${cookies.length > 100 ? "..." : ""}`);
  } catch (error) {
    console.error(`x Cookie extraction failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (!process.env.NODE_TEST_CONTEXT) {
  main().catch((error) => {
    console.error(`x Unexpected failure: ${error.message}`);
    process.exitCode = 1;
  });
}
