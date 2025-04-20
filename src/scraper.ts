import puppeteer from "puppeteer";
import fs from "fs";
import pLimit from "p-limit";
import { createObjectCsvWriter } from "csv-writer";

interface Planner {
  name: string;
  profileUrl: string;
  website: string | null;
  instagram: string | null;
  email: string | null;
}

(async () => {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  const limit = pLimit(5); // safer concurrency
  const allLinks: { name: string; profileUrl: string }[] = [];
  let currentPage = 41;
  let maxPage = 61;
  while (currentPage < maxPage) {
    const url = `https://www.partyslate.com/find-vendors/event-planner?page=${currentPage}`;
    console.log(`Scraping list page ${currentPage}...`);

    await page.goto(url, { waitUntil: "networkidle2" });
    await page.waitForSelector(
      "h3.src-components-CompanyDirectoryCard-components-Header-Header-module__title__2okBV a",
      { timeout: 10000 }
    );

    const links = await page.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll(
          "h3.src-components-CompanyDirectoryCard-components-Header-Header-module__title__2okBV a"
        )
      );
      return elements.map((el) => ({
        name: el.textContent?.trim() || "",
        profileUrl: (el as HTMLAnchorElement).href,
      }));
    });

    allLinks.push(...links);

    const hasNextPage =
      (await page.$('a[data-testid="next-page-link"]')) !== null;

    if (!hasNextPage) {
      console.log("✅ No more pages. Stopping...");
      break;
    }

    currentPage++;
  }

  console.log(
    `✅ Found ${allLinks.length} planner profiles. Visiting them concurrently...`
  );

  const planners: Planner[] = await Promise.all(
    allLinks.map((link) =>
      limit(async () => {
        const tab = await browser.newPage();
        try {
          await tab.goto(link.profileUrl, {
            waitUntil: "networkidle2",
          });
          await tab.waitForSelector("div[class*='DetailsFooter']", {
            timeout: 10000,
          });

          const { website, instagram } = await tab.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll("a"));
            const result = {
              website: null as string | null,
              instagram: null as string | null,
            };

            for (const a of anchors) {
              const href = a.href;

              if (
                !result.website &&
                href.includes("partyslate.com/outbound") &&
                href.includes("target=")
              ) {
                try {
                  const url = new URL(href);
                  const target = url.searchParams.get("target");
                  if (target && !target.includes("instagram.com")) {
                    result.website = decodeURIComponent(target);
                  }
                } catch (err) {
                  // malformed URL
                }
              }

              if (!result.instagram && href.includes("instagram.com")) {
                result.instagram = href;
              }
            }

            return result;
          });

          console.log(`✅ Scraped: ${link.name}`);
          return {
            name: link.name,
            profileUrl: link.profileUrl,
            website,
            instagram,
            email: null,
          };
        } catch (err) {
          console.warn(`⚠️ Failed to scrape ${link.name}: ${err}`);
          return {
            name: link.name,
            profileUrl: link.profileUrl,
            website: null,
            instagram: null,
            email: null,
          };
        } finally {
          try {
            await tab.close();
          } catch (e) {
            console.warn(`⚠️ Failed to close tab for ${link.name}: ${e}`);
          }
        }
      })
    )
  );

  const emailLimit = pLimit(5); // limit concurrent website checks
  const brokenLinks = ["https://www.viaggiodeifiori.co.za/"];
  await Promise.all(
    planners.map((planner) =>
      emailLimit(async () => {
        if (!planner.website) return;

        const base = planner.website.replace(/\/+$/, "");
        if (brokenLinks.some((bad) => planner.website?.includes(bad))) {
          console.warn(`⚠️ Skipping broken site: ${planner.website}`);
          return;
        }
        const pathsToTry = [
          "",
          "/contact",
          "/contact-us",
          "/about",
          "/about-us",
          "/team",
          "/connect",
          "/inquire",
        ];

        const emailTab = await browser.newPage();
        planner.email = null;

        try {
          for (const path of pathsToTry) {
            const fullUrl = base + path;
            try {
              console.log(`🔍 Trying ${fullUrl}`);
              await emailTab.goto(fullUrl, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
              });

              const email = await emailTab.evaluate(() => {
                const bodyText = document.body.innerText;
                const match = bodyText.match(
                  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
                );
                return match ? match[0] : null;
              });

              if (email) {
                planner.email = email;
                console.log(`📧 ${planner.name} → ${email}`);
                break;
              }
            } catch (err) {
              console.warn(`⚠️ ${fullUrl} failed: ${(err as Error).message}`);
            }
          }

          // If no email from common paths, try dynamic links
          if (!planner.email) {
            console.log(`🔎 No email from paths. Scanning links on ${base}...`);
            try {
              await emailTab.goto(base, {
                waitUntil: "domcontentloaded",
                timeout: 15000,
              });

              const dynamicContactLinks = await emailTab.evaluate(() => {
                const anchors = Array.from(document.querySelectorAll("a"));
                return anchors
                  .map((a) => a.href)
                  .filter(
                    (href) =>
                      href &&
                      href.includes(location.origin) &&
                      /contact|about|connect|get-in-touch/i.test(href)
                  );
              });

              for (const url of dynamicContactLinks) {
                try {
                  console.log(`🔗 Trying dynamic contact page: ${url}`);
                  await emailTab.goto(url, {
                    waitUntil: "domcontentloaded",
                    timeout: 15000,
                  });

                  const email = await emailTab.evaluate(() => {
                    const bodyText = document.body.innerText;
                    const match = bodyText.match(
                      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
                    );
                    return match ? match[0] : null;
                  });

                  if (email) {
                    planner.email = email;
                    console.log(`📧 ${planner.name} → ${email}`);
                    break;
                  }
                } catch (err) {
                  console.warn(`⚠️ Failed to scrape dynamic link: ${url}`);
                }
              }

              if (!planner.email) {
                console.log(`❌ Still no email found for ${planner.name}`);
              }
            } catch (err) {
              console.warn(
                `⚠️ Error scanning dynamic links: ${(err as Error).message}`
              );
            }
          }
        } finally {
          try {
            await emailTab.close();
          } catch (e) {
            console.warn(`⚠️ Could not close email tab for ${planner.name}`);
          }
        }
      })
    )
  );

  await browser.close();

  const csvWriter = createObjectCsvWriter({
    path: "planners_full.csv",
    header: [
      { id: "name", title: "Name" },
      { id: "profileUrl", title: "Profile URL" },
      { id: "website", title: "Website" },
      { id: "instagram", title: "Instagram" },
      { id: "email", title: "Email" },
    ],
  });

  await csvWriter.writeRecords(planners);
  console.log("✅ All data saved to planners_full.csv");
})();
