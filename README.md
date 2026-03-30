# Inkwell — Drawing Studio

A full-featured, browser-based drawing application that provides professional-grade tools like a multi-layer system, various brush styles, a vector pen with bezier curves, and an advanced viewport-based zoom and pan system.

## ✨ Features

- **Professional Drawing Tools**:
  - **Figma-like Vector Pen**: Click to add corners, click and drag for smooth bezier handles, Ctrl+drag to adjust existing handles, and Ctrl+Z to undo the last anchor.
  - **Versatile Brushes**: Choose from Round, Calligraphy, Spray, Marker, and Pencil styles to achieve the perfect stroke.
  - **Paint Bucket**: Quickly fill enclosed regions dynamically.
  - **Eraser**: Clean up mistakes seamlessly.
- **Infinite Viewport Navigation**: 
  - Effortlessly zoom and pan around your canvas using scroll wheels (Ctrl+scroll to zoom), Space+drag, middle-mouse button, or touch pinch-to-zoom mechanics.
- **Layer Management**:
  - Add, delete, rename, and toggle visibility for multiple drawing layers.
  - Drag and drop any image into the canvas to create a specialized **Trace Layer** with adjustable opacity.
- **Color & Size Control**:
  - Use the built-in vivid color palette or select any custom color with the native color picker.
  - Smoothly adjust brush thickness using the vertical size slider.
- **Layer-Scoped History**: 
  - Robust Undo and Redo operations isolated to each individual layer.
- **Save & Export**: 
  - Export your masterpiece as a flattened `PNG` image, or export drawn vector paths as an `SVG` file.

## 🗂️ Project Structure

- `index.html`: The main skeletal structure and UI markup (toolbars, layers panel, viewport containers).
- `style.css`: A sleek, responsive dark theme applying modern CSS concepts, backdrop blurs, and flexbox configurations.
- `script.js`: The powerhouse of the application managing the Canvas API logic, complex pointer events, math for the vector pen, zoom transformations, and state history.

## 🚀 How to Run

1. Clone or download the repository to your local machine.
2. Ensure all three files (`index.html`, `style.css`, `script.js`) are in the same folder.
3. Simply double-click `index.html` to open it in any modern web browser. No build steps, packages, or local servers are required!

## 🛠️ Technologies Used

- **HTML5** (Canvas API)
- **Vanilla JavaScript** (ES6+)
- **Vanilla CSS3**
