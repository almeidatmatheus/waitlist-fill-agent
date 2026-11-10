// Does a free-text message name a specific clock time? Used to recognise a patient picking one of the
// times the clinic offered ("2:30pm please", "14:30 works", "half past 2", "4pm"), never to parse new times.

/** `hm` is the local wall-clock time "HH:mm". */
export function mentionsTime(text: string, hm: string): boolean {
  const [H, M] = hm.split(':').map(Number);
  if (!Number.isInteger(H) || !Number.isInteger(M)) return false;
  const h12 = H % 12 || 12, ap = H < 12 ? 'a' : 'p', mm = String(M).padStart(2, '0');
  const t = text.toLowerCase();
  const meridiem = `\\s*${ap}\\.?\\s?m\\b\\.?`;
  const pats = M === 0
    ? [
        `\\b${h12}${meridiem}`,                    // 4pm, 4 p.m.
        `\\b${h12}\\s*o'?\\s?clock\\b`,            // 4 o'clock
        `\\b0?${H}[:.]00\\b`,                      // 16:00
        `\\b${h12}[:.]00\\b`,                      // 4:00
      ]
    : [
        `\\b${h12}[:.]${mm}(?!\\d)`,               // 2:30, 2.30
        `\\b0?${H}[:.]${mm}(?!\\d)`,               // 14:30
        `\\b${h12}${mm}${meridiem}`,               // 230pm
        ...(M === 30 ? [`\\bhalf (past )?${h12}\\b`] : []),
        ...(M === 15 ? [`\\bquarter past ${h12}\\b`] : []),
        ...(M === 45 ? [`\\bquarter to ${(h12 % 12) + 1}\\b`] : []),
      ];
  return pats.some(p => new RegExp(p).test(t));
}
