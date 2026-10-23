# Twin Avatars

Generic avatars for Twins that look like the dotted photo avatars, without a
photo. A Twin's name or ID picks a set of traits. The traits paint a
synthetic grayscale portrait: a lit head with soft features, hair texture
and clothes. The portrait then goes through
the photo tool's exact dot pipeline (52-unit hex grid, area sampling, brand
blue `#0021CC` duotone on cream, darker = bigger). Every avatar sits on the
same plain light wall. The same seed always gives
the same avatar.

**Live (once deployed):** https://wmirner.github.io/dot-image/generator/

## Parts

You can pick (or lock) the parts you'd use to describe someone: hair length,
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

"Hold to see photo" shows the grayscale portrait under the dots.

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
TwinAvatar.svg(t);                            // SVG string
TwinAvatar.draw(ctx, 512, t);                 // onto a canvas
TwinAvatar.encode(t);                         // "8GCCDILJ"
TwinAvatar.decode("8GCCDILJ");                // traits back
TwinAvatar.portrait(t);                       // the grayscale source
```
