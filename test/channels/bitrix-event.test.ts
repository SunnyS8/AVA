import { describe, it, expect } from "vitest";
import { parseBitrixEvent } from "../../src/channels/bitrix/event.js";

const body = [
  "event=ONIMBOTMESSAGEADD",
  "data%5BPARAMS%5D%5BDIALOG_ID%5D=chat42",
  "data%5BPARAMS%5D%5BFROM_USER_ID%5D=17",
  "data%5BPARAMS%5D%5BMESSAGE%5D=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82",
  "auth%5Bapplication_token%5D=tok123",
].join("&");

describe("parseBitrixEvent", () => {
  it("pulls dialog, author, text and token out of a real payload", () => {
    const e = parseBitrixEvent(body)!;
    expect(e.event).toBe("ONIMBOTMESSAGEADD");
    expect(e.dialogId).toBe("chat42");
    expect(e.fromUserId).toBe("17");
    expect(e.text).toBe("Привет");
    expect(e.applicationToken).toBe("tok123");
    expect(e.fromBot).toBe(false);
  });

  it("marks messages sent by bots so we never answer ourselves", () => {
    const e = parseBitrixEvent(body + "&data%5BPARAMS%5D%5BAUTHOR_ID%5D=0")!;
    expect(e.fromBot).toBe(true);
  });

  it("returns null on a body that is not an event", () => {
    expect(parseBitrixEvent("")).toBeNull();
    expect(parseBitrixEvent("hello=world")).toBeNull();
  });
});
