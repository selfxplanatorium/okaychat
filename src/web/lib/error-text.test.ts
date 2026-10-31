import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "./api.js";
import { errorText } from "./error-text.js";

test("a settings error shows a translated message, not a raw JS error", () => {
  assert.equal(errorText(new Error("apiKey=sk-live-SECRETVALUE prompt PROMPT_SECRET"), "common.somethingWentWrong"), "Something went wrong.");
  assert.equal(errorText({ message: "raw object" }, "common.somethingWentWrong"), "Something went wrong.");
});

test("a structured ApiError keeps its translated code and safe authored detail", () => {
  const validation = new ApiError("Enter a display name between 1 and 80 characters.", 400, {
    code: "validation",
    message: "Enter a display name between 1 and 80 characters.",
    retryable: false,
  });
  assert.match(errorText(validation, "common.somethingWentWrong"), /That request was not valid\..*Enter a display name/);

  const auth = new ApiError("raw provider text", 401, { code: "provider_auth", message: "raw provider text", retryable: false });
  assert.equal(errorText(auth, "common.somethingWentWrong"), "The provider rejected the credentials.");
});
