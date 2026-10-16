# TRAVA. background GIF

The default background is `trava-bg.gif` in this folder. Replace that file with another GIF using **the same filename** to change the default for everyone. The CSS on all pages fills the available screen with `background-size: cover`, so uploads with a different aspect ratio are cropped at the edges rather than stretched.

For a single reusable export across desktop and phone screens, use a **1200 × 1200 px square GIF**, keep important artwork near the center, and keep the file under **15 MB** for reasonable loading. The current default file is **500 × 700 px**; it still works, but can look soft on larger screens.

There is no background control on the public pages. To update the site, replace `trava-bg.gif` in the `public` folder and deploy that folder. If the old animation remains visible, clear the browser cache or reload without cache.
