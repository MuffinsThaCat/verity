import { staticSource, type Source } from "../lib/sources.js";

/** A tiny offline "web" for the demo and tests. Real runs use WikipediaProvider instead. */
export function plutoCorpus(): Source[] {
  return [
    staticSource(
      "Pluto",
      [
        "Pluto is a dwarf planet in the Kuiper belt, a ring of bodies beyond the orbit of Neptune.",
        "Pluto has five known natural satellites: Charon, Styx, Nix, Kerberos and Hydra.",
        "Pluto was discovered in 1930 by Clyde Tombaugh at Lowell Observatory.",
        "Pluto takes about 248 years to complete one orbit of the Sun.",
        "Charon is the largest moon of Pluto.",
        "Pluto was visited by the New Horizons spacecraft in 2015.",
      ].join("\n"),
    ),
    staticSource(
      "Planet definition",
      [
        "In 2006 the International Astronomical Union reclassified Pluto as a dwarf planet.",
        "A planet must clear the neighbourhood around its orbit, and Pluto does not.",
      ].join("\n"),
    ),
  ];
}

export const PLUTO_TOPIC = "pluto";

export const PLUTO_TRUE_CLAIMS = [
  "Pluto is a dwarf planet in the Kuiper belt.",
  "Pluto has five known natural satellites.",
  "Pluto was discovered in 1930 by Clyde Tombaugh.",
  "The International Astronomical Union reclassified Pluto as a dwarf planet in 2006.",
  "Pluto takes about 248 years to orbit the Sun.",
];

export const PLUTO_FALSE_CLAIM = "Pluto has twelve known natural satellites.";
