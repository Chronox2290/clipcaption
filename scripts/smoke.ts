import { paginate, censorWord, pageAt, activeWordIndex } from "../src/lib/captions";
import { buildAss } from "../src/lib/ass";
import { STYLE_PRESETS } from "../src/lib/styles";

const segs = [{
  id: "s1",
  words: [
    { text: "That", start: 0.2, end: 0.4 },
    { text: "was", start: 0.4, end: 0.55 },
    { text: "an", start: 0.55, end: 0.7 },
    { text: "insane", start: 0.7, end: 1.1 },
    { text: "fucking", start: 1.1, end: 1.5 },
    { text: "clutch!", start: 1.5, end: 2.0 },
  ],
}];

const pages = paginate(segs, 4);
console.log("pages:", JSON.stringify(pages.map(p => ({ s: p.start, e: p.end, n: p.words.length }))));
console.log("censor:", censorWord("fucking"), censorWord("clutch!"), censorWord("Shit,"));
const pg = pageAt(pages, 0.8)!;
console.log("activeIdx@0.8:", activeWordIndex(pg, 0.8));

for (const st of STYLE_PRESETS) {
  const ass = buildAss(pages, st, { playResX: 1920, playResY: 1080 });
  const ok = ass.includes("[Script Info]") && ass.includes("Style: Cap,") && ass.split("Dialogue:").length > 1;
  console.log(st.id, ok ? "OK" : "FAIL", "dialogues:", ass.split("Dialogue:").length - 1);
  if (st.id === "beast") {
    console.log(ass.split("\n").slice(0, 12).join("\n"));
    console.log("...");
    console.log(ass.split("\n").filter(l => l.startsWith("Dialogue")).slice(0, 3).join("\n"));
  }
}
