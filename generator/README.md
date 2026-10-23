# Twin Avatars

Generic avatars for Twins that look like the dotted photo avatars, without a
photo. A Twin's name or ID picks a set of traits. The traits paint a
synthetic grayscale portrait: a lit head with soft features, hair texture
and clothes. The portrait then goes through
the photo tool's dot pipeline (a slightly finer 46-unit hex grid, area sampling, brand
blue `#0021CC` duotone, darker = bigger) on a transparent background. Every avatar sits on a
plain wall: light by default, and mid or dark behind white and light tops,
whichever keeps the face and hair readable. The same seed always gives
the same avatar.

**Live (once deployed):** https://wmirner.github.io/dot-image/generator/

## Parts

You can pick (or lock) the parts you'd use to describe someone: presentation
(feminine, masculine or androgynous), age (20s, 30s–40s, 50s, 65+), hair length,
hair texture, hair color, skin tone, expression, facial hair, accessory
(glasses, sunglasses, beanie, cap, headphones, earrings) and top.

Hidden parts make each one read as a different photo: hair cut, face shape,
eyes, brows, nose, top shade, pose and lighting. These are
only picked from the seed. Head size is fixed and placement is near-identical
across avatars (face shapes vary in proportion, not size). A few units of
seeded jitter in position, tilt and exposure keep them from feeling stamped.

Eyes, brows, nose and mouth are always diffused: the portrait is rendered with
and without them, and only the difference is blurred before it's added back.
So features read as soft shading across several dots, never as single dots.

Presentation is split evenly three ways. It changes the odds for hair
length, facial hair and accessories (`odds` in `PARTS`) instead of forcing
them: feminine leans medium and long hair with earrings more often, masculine
leans short hair with facial hair about half the time, and androgynous sits
in between. Facial hair never comes up for feminine. Locked parts always win, but locking
facial hair on its own steers presentation to masculine or androgynous; a
bearded feminine avatar only happens when both are locked on purpose.

Age is split evenly four ways. Older avatars are more likely to have grey or
white hair, glasses and a shorter or receding hairline, and get softly shaded
lines (nose-to-mouth folds, under-eye shadows, forehead lines). Skin tone is
split evenly five ways, and hair texture covers straight, wavy, curly and coily
(each at least about a fifth). Expressions are neutral or smiling only: neutral,
slight smile, smile, big smile, laughing and half smile.

## Keeping it respectful

These are rules for anyone adding parts:

- **Skin tone stands alone.** It's never tied to presentation or any other
  trait, so no feature, hair style, outfit or accessory is paired with a skin
  tone by design.
- **No feature exaggeration.** Lips, nose and eye options vary within a
  normal range only, and never as a caricature.
- **Equal readability.** Facial features get extra contrast on deeper skin,
  so no face renders as a featureless silhouette. Teeth in a big smile stay
  close to the skin tone, never a bright mouth on a darker face.
- **The wall contrasts with the face.** It's picked per avatar so no face
  blends into the background.
- **No loaded clothing or symbols.** There are no religious, cultural or
  ceremonial garments and no symbols. Hoods are always down. Expressions are
  neutral or smiling only.
- **Codes can't spell words.** The code alphabet has no vowels and no 0, 1,
  3 or 4, so a code can never spell a word or slur.

Run any new part across all five skin tones before shipping it.

## Adding parts

Everything lives in `avatar.js`:

1. Add an option to the part's list in `PARTS` (`opt(id, label, weight)`).
   Append it to the end, because codes depend on option order.
2. Draw it in `scene()`. Hair shapes are in `HAIR`, and `STYLES` maps
   length and texture to them.

Adding a whole new part changes every existing code, so do that before codes
are stored anywhere.

## Using it in code

`avatar.js` has no dependencies and doesn't touch the DOM:

```js
const t = TwinAvatar.fromSeed("twin_8c1f");   // traits
TwinAvatar.svg(t);                            // SVG string, transparent
TwinAvatar.svg(t, { background: TwinAvatar.BG }); // ...or on cream
TwinAvatar.draw(ctx, 512, t);                 // onto a canvas
TwinAvatar.encode(t);                         // "BXK7RTMQ"
TwinAvatar.decode("BXK7RTMQ");                // traits back
TwinAvatar.portrait(t);                       // the grayscale source
```
