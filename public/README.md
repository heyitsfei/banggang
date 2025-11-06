# Static Images for Bang Gang Miniapp

This directory contains the static images needed for the Farcaster miniapp embeds.

## Required Images

### 1. `og-image.png` - Open Graph Image
**Purpose:** Displayed in social feed embeds when the miniapp is shared

**Requirements:**
- Format: PNG (recommended for best compatibility)
- Aspect ratio: 3:2 (width:height)
- Minimum dimensions: 600x400px
- Maximum dimensions: 3000x2000px
- File size: Must be less than 10MB
- Should visually represent your game (gun, players, etc.)

**Example dimensions:** 1200x800px or 1500x1000px

### 2. `splash.png` - Splash Screen
**Purpose:** Shown when the miniapp is launching/loading

**Requirements:**
- Format: PNG
- Recommended: Square or 1:1 aspect ratio
- Size: 512x512px or 1024x1024px
- Should be your app logo or branding

## How to Create the Images

### Option 1: Design Tools
- Use Figma, Canva, or Photoshop
- Create images matching the requirements above
- Export as PNG
- Place in this `public/` directory

### Option 2: Generate Programmatically
You can create these images using code (e.g., with Canvas API, Sharp, or similar tools).

### Option 3: Use Online Tools
- Use tools like [OG Image Generator](https://og-image.vercel.app/)
- Or create simple images with your game branding

## Image Ideas

**og-image.png:**
- A revolver/revolver cylinder
- "Bang Gang" text with game branding
- Dark theme matching your game UI
- Maybe show "Russian Roulette" or game concept

**splash.png:**
- Your app logo
- Simple, clean design
- Matches your brand colors (#667eea purple gradient)

## Testing

Once you've added the images:
1. Deploy to Render
2. Visit `https://banggang.onrender.com/og-image.png` to verify it loads
3. Visit `https://banggang.onrender.com/splash.png` to verify it loads
4. Test the miniapp embed in Warpcast to see how it looks

## Notes

- Images are served with 1 hour cache (`Cache-Control: public, max-age=3600`)
- If you update images, you may need to wait for cache to clear or use a different filename
- The images will be automatically served at the root URLs when placed in this directory

