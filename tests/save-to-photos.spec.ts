import { test, expect, type Page } from "@playwright/test";

type ShareCall = {
  names: string[];
  types: string[];
  sizes: number[];
  userActivation: boolean | null;
};

async function mockShareSheet(page: Page) {
  await page.addInitScript(() => {
    const calls: ShareCall[] = [];
    (window as unknown as { __shareCalls: ShareCall[] }).__shareCalls = calls;
    navigator.canShare = (data?: ShareData) => !!(data && data.files && data.files.length > 0);
    navigator.share = async (data?: ShareData) => {
      const files = data?.files ? Array.from(data.files) : [];
      calls.push({
        names: files.map((f) => f.name),
        types: files.map((f) => f.type),
        sizes: files.map((f) => f.size),
        userActivation: navigator.userActivation ? navigator.userActivation.isActive : null,
      });
    };
  });
}

async function shareCalls(page: Page): Promise<ShareCall[]> {
  return page.evaluate(() => (window as unknown as { __shareCalls: ShareCall[] }).__shareCalls ?? []);
}

test.describe("iPhone share sheet", () => {
  test.skip(({ browserName }) => browserName !== "webkit", "WebKit / iPhone profile only");

  test("opens the share sheet with the original filename, image type, and nonzero size", async ({
    page,
  }) => {
    await mockShareSheet(page);
    await page.goto("/?name=DSC_1234.jpg");
    const button = page.getByTestId("save-photo-button");
    await expect(button).toHaveAttribute("data-mode", "share");
    await expect(button).toHaveAttribute("data-prefetch", "ready");
    await expect(button).toHaveAttribute("aria-label", "Save to Photos");

    const fetchAfterReady: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/photos/")) fetchAfterReady.push(req.url());
    });

    await button.click();

    await expect.poll(async () => (await shareCalls(page)).length).toBe(1);
    const call = (await shareCalls(page))[0];
    expect(call.names).toEqual(["DSC_1234.jpg"]);
    expect(call.types).toEqual(["image/jpeg"]);
    expect(call.sizes[0]).toBeGreaterThan(0);
    // Prefetch already had the file, so the click itself must not fetch again.
    expect(fetchAfterReady).toEqual([]);
  });

  test("if the original is not prefetched, first tap prepares and a second tap shares", async ({
    page,
  }) => {
    await mockShareSheet(page);
    await page.goto("/?slow=1&name=DSC_1234.jpg");
    const button = page.getByTestId("save-photo-button");
    await expect(button).toHaveAttribute("data-mode", "share");
    await expect(button).toHaveAttribute("data-prefetch", "loading");

    await button.click();
    await expect(button).toHaveText(/Preparing/);
    expect(await shareCalls(page)).toEqual([]);

    await expect(button).toHaveText("Save to Photos");
    await expect(button).toHaveAttribute("data-prefetch", "ready");

    await button.click();
    await expect.poll(async () => (await shareCalls(page)).length).toBe(1);
    const call = (await shareCalls(page))[0];
    expect(call.names).toEqual(["DSC_1234.jpg"]);
    expect(call.types).toEqual(["image/jpeg"]);
    expect(call.sizes[0]).toBeGreaterThan(0);
  });

  test("uses a derived name when original_filename is missing", async ({ page }) => {
    await mockShareSheet(page);
    await page.goto("/?noName=1&fallback=Mendhi_001.jpg");
    const button = page.getByTestId("save-photo-button");
    await expect(button).toHaveAttribute("data-prefetch", "ready");
    await button.click();
    await expect.poll(async () => (await shareCalls(page)).length).toBe(1);
    expect((await shareCalls(page))[0].names).toEqual(["Mendhi_001.jpg"]);
  });
});

test.describe("desktop download", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Desktop Chromium only");

  test("keeps the classic file download", async ({ page }) => {
    await page.goto("/?name=DSC_1234.jpg");
    const button = page.getByTestId("save-photo-button");
    await expect(button).toHaveAttribute("data-mode", "download");
    await expect(button).toHaveAttribute("aria-label", "Download photo");
    await expect(button).toHaveAttribute("data-prefetch", "ready");

    const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
    expect(download.suggestedFilename()).toBe("DSC_1234.jpg");
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    if (!stream) throw new Error("download had no stream");
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
  });
});
