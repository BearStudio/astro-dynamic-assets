import { FontStyle, FontWeight } from "satori";

type Font = {
  name: string;
  url: string;
  style: FontStyle;
  weight: FontWeight;
};

export type Config = {
  fonts: Array<Font>;

  /**
   * Give the Astro site options specified in your project's `astro.config` (you can use `import.meta.env.SITE`).
   */
  site: string;
  ssr?: boolean;
};
