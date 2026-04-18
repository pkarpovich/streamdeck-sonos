import { describe, expect, it } from "vitest";
import { tryCatch } from "./tryCatch.js";

describe("tryCatch", () => {
  it("returns data and null error on success", async () => {
    const result = await tryCatch(Promise.resolve(42));
    expect(result).toEqual({ data: 42, error: null });
  });

  it("returns null data and the error on rejection", async () => {
    const boom = new Error("boom");
    const result = await tryCatch(Promise.reject(boom));
    expect(result).toEqual({ data: null, error: boom });
  });
});
