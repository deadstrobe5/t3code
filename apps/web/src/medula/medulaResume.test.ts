import { describe, expect, it } from "vite-plus/test";

import {
  formatResumeClock,
  medulaResumeSummary,
  medulaResumeTitle,
  parseMedulaResume,
} from "./medulaResume";

const NOW = new Date(2026, 9, 23, 3, 30);
const at = (hours: number, minutes: number, day = 23) =>
  new Date(2026, 9, day, hours, minutes).toISOString();

describe("parseMedulaResume", () => {
  it("keeps only well-formed entries", () => {
    expect(
      parseMedulaResume({
        enabled: true,
        intervalSeconds: 60,
        threads: [
          { threadId: "a", resumeAt: at(5, 0), state: "waiting" },
          { threadId: "b", resumeAt: "nunca" },
          { threadId: 3, resumeAt: at(5, 0) },
          { threadId: "c", resumeAt: at(6, 0), state: "sent" },
        ],
      }),
    ).toEqual({
      enabled: true,
      intervalSeconds: 60,
      threads: [
        { threadId: "a", resumeAt: at(5, 0), state: "waiting" },
        { threadId: "c", resumeAt: at(6, 0), state: "sent" },
      ],
    });
    expect(parseMedulaResume({ configured: true })).toBeNull();
    expect(parseMedulaResume(null)).toBeNull();
  });
});

describe("medula resume texts", () => {
  const list = parseMedulaResume({
    enabled: true,
    intervalSeconds: 60,
    threads: [
      { threadId: "a", resumeAt: at(5, 0), state: "waiting" },
      { threadId: "b", resumeAt: at(4, 15), state: "waiting" },
      { threadId: "c", resumeAt: at(3, 20), state: "sent" },
    ],
  });

  it("shows the clock, with the weekday when it isn't today", () => {
    expect(formatResumeClock(at(5, 0), NOW)).toBe("05:00");
    expect(formatResumeClock(at(5, 0, 24), NOW)).toMatch(/^\S+ 05:00$/);
  });

  it("titles the thread's banner and stays quiet otherwise", () => {
    expect(medulaResumeTitle(list, "a", NOW)).toBe("Quota gasta · retoma às 05:00");
    expect(medulaResumeTitle(list, "c", NOW)).toBe("Quota gasta · retoma enviada às 03:20");
    expect(medulaResumeTitle(list, "z", NOW)).toBeNull();
    expect(medulaResumeTitle({ ...list!, enabled: false }, "a", NOW)).toBeNull();
  });

  it("summarises the waiting threads for the panel", () => {
    expect(medulaResumeSummary(list, NOW)).toBe(
      "Quota gasta · 2 conversas à espera · próxima retoma às 04:15",
    );
    expect(medulaResumeSummary({ ...list!, threads: [] }, NOW)).toBeNull();
  });
});
