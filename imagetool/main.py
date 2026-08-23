import io
import uvicorn
from fastapi import FastAPI, File, UploadFile, Query, HTTPException, Form
from fractions import Fraction
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image
import rembg

app = FastAPI(
    title="Image Tool API",
    description="High-quality AI background removal API using rembg",
    version="1.0.0"
)

# Enable CORS so the Chrome Extension (or other apps) can query it directly
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize global rembg session to avoid reloading model on every request
from rembg import new_session
print("Initializing rembg session...")
try:
    rembg_session = new_session("u2net")
    print("rembg session initialized successfully.")
except Exception as e:
    print("Failed to initialize rembg session:", e)
    rembg_session = None

@app.on_event("startup")
async def startup_event():
    print("Pre-loading rembg AI model into memory...")
    try:
        # Create a tiny 1x1 dummy image to force model load
        dummy_img = Image.new("RGBA", (1, 1), (0, 0, 0, 0))
        rembg.remove(dummy_img, session=rembg_session)
        print("rembg AI model warmed up successfully and cached in memory!")
    except Exception as e:
        print("Failed to warm up rembg model:", e)

@app.get("/")
async def health_check():
    return {"status": "ok", "service": "Image Tool API"}

@app.post("/remove-bg")
async def remove_background_api(
    file: UploadFile = File(...),
    crop: bool = Query(False, description="Auto-crop transparent borders after removing background")
):
    try:
        # Read uploaded image bytes
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="Empty file uploaded")

        input_image = Image.open(io.BytesIO(contents))
        
        # Run rembg AI background removal
        output_image = rembg.remove(input_image)
        
        # Auto-crop transparent boundaries if requested
        if crop:
            bbox = output_image.getbbox()
            if bbox:
                output_image = output_image.crop(bbox)
        
        # Save output image back to PNG bytes
        img_byte_arr = io.BytesIO()
        output_image.save(img_byte_arr, format='PNG')
        img_byte_arr.seek(0)
        
        return Response(content=img_byte_arr.getvalue(), media_type="image/png")
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/process-image")
async def process_image_api(
    file: UploadFile = File(...),
    bg_remove: bool = Form(False),
    crop: bool = Form(False),
    bg_color: str = Form(None),
    resolution: str = Form("0"),
    contain_fit: bool = Form(False),
    format: str = Form("webp"),
    quality: int = Form(90),
    target_size_kb: int = Form(None),
    title: str = Form(None),
    author: str = Form(None),
    description: str = Form(None),
    make: str = Form(None),
    model: str = Form(None),
    lens_model: str = Form(None),
    software: str = Form(None),
    copyright: str = Form(None),
    gps_latitude: str = Form(None),
    gps_longitude: str = Form(None),
    date_time_original: str = Form(None)
):
    try:
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="Empty file uploaded")

        input_image = Image.open(io.BytesIO(contents))

        # 1. Background removal
        if bg_remove:
            input_image = rembg.remove(input_image, session=rembg_session)

        # 2. Transparent border crop
        if crop:
            bbox = input_image.getbbox()
            if bbox:
                input_image = input_image.crop(bbox)

        # 3. Background color fill
        if bg_color and bg_color.strip():
            bg_color = bg_color.strip()
            # If the image has transparency (RGBA/LA), composite it over background color
            if input_image.mode in ('RGBA', 'LA') or (input_image.mode == 'P' and 'transparency' in input_image.info):
                bg = Image.new("RGBA", input_image.size, bg_color)
                bg.paste(input_image, mask=input_image.split()[-1])
                input_image = bg.convert("RGB")
            else:
                bg = Image.new("RGB", input_image.size, bg_color)
                bg.paste(input_image)
                input_image = bg

        # 4. Resize/Resolution
        res = resolution.strip()
        if 'x' in res:
            try:
                w_str, h_str = res.split('x')
                req_w = int(w_str)
                req_h = int(h_str)
                if req_w > 0 and req_h > 0:
                    if contain_fit:
                        # Contain-fit: scale image down to fit in target box, center it
                        input_image.thumbnail((req_w, req_h), Image.Resampling.LANCZOS)
                        # Determine container mode
                        out_fmt = format.lower()
                        mode = "RGBA" if out_fmt == "png" or (out_fmt == "webp" and not bg_color) else "RGB"
                        bg_c = bg_color if bg_color else (0, 0, 0, 0)
                        container = Image.new(mode, (req_w, req_h), bg_c)
                        # Center it
                        offset_x = (req_w - input_image.width) // 2
                        offset_y = (req_h - input_image.height) // 2
                        container.paste(input_image, (offset_x, offset_y))
                        input_image = container
                    else:
                        # Crop-to-fill (cover)
                        input_ratio = input_image.width / input_image.height
                        target_ratio = req_w / req_h
                        if input_ratio > target_ratio:
                            new_h = req_h
                            new_w = int(req_h * input_ratio)
                            resized = input_image.resize((new_w, new_h), Image.Resampling.LANCZOS)
                            crop_x = (new_w - req_w) // 2
                            input_image = resized.crop((crop_x, 0, crop_x + req_w, req_h))
                        else:
                            new_w = req_w
                            new_h = int(req_w / input_ratio)
                            resized = input_image.resize((new_w, new_h), Image.Resampling.LANCZOS)
                            crop_y = (new_h - req_h) // 2
                            input_image = resized.crop((0, crop_y, req_w, crop_y + req_h))
            except Exception as e:
                print("Resize error:", e)
        else:
            try:
                max_w = int(res)
                if max_w > 0 and input_image.width > max_w:
                    scale = max_w / input_image.width
                    new_w = max_w
                    new_h = int(input_image.height * scale)
                    input_image = input_image.resize((new_w, new_h), Image.Resampling.LANCZOS)
            except ValueError:
                pass

        # 5. Build EXIF metadata
        exif = input_image.getexif()
        if title:
            exif[0x9c9b] = title.encode('utf-16le')
        if author:
            exif[0x013b] = author
        if make:
            exif[0x010f] = make
        if model:
            exif[0x0110] = model
        if lens_model:
            exif[0xa434] = lens_model
        if software:
            exif[0x0131] = software
        if copyright:
            exif[0x8298] = copyright
        if date_time_original:
            exif[0x9003] = date_time_original
            exif[0x0132] = date_time_original

        # Add GPS tags if provided
        if gps_latitude and gps_longitude:
            try:
                def parse_coord(coord_str, is_lat=True):
                    coord_str = coord_str.strip()
                    parts = coord_str.split()
                    val = float(parts[0])
                    ref = ""
                    if len(parts) > 1:
                        ref = parts[1].upper()
                    else:
                        if is_lat:
                            ref = "N" if val >= 0 else "S"
                        else:
                            ref = "E" if val >= 0 else "W"
                    val = abs(val)
                    d = int(val)
                    m = int((val - d) * 60)
                    s = (val - d - m/60) * 3600
                    s = round(s, 4)
                    return ref, (Fraction(d, 1), Fraction(m, 1), Fraction(int(s * 10000), 10000))

                lat_ref, lat_dms = parse_coord(gps_latitude, is_lat=True)
                lon_ref, lon_dms = parse_coord(gps_longitude, is_lat=False)

                gps_ifd = exif.get_ifd(0x8825)
                gps_ifd[1] = lat_ref
                gps_ifd[2] = lat_dms
                gps_ifd[3] = lon_ref
                gps_ifd[4] = lon_dms
            except Exception as e:
                print("GPS parsing error:", e)

        # 6. Format and save kwargs
        out_fmt = format.lower()
        if out_fmt == 'jpg':
            out_fmt = 'jpeg'
        elif out_fmt == 'def':
            out_fmt = 'webp'

        save_kwargs = {"format": out_fmt.upper()}
        if out_fmt in ('jpeg', 'webp', 'tiff'):
            save_kwargs["quality"] = quality

        # Check target size
        if target_size_kb and target_size_kb > 0:
            target_bytes = target_size_kb * 1024
            best_bytes = None

            if out_fmt == 'png':
                # PNG doesn't support quality. We scale the dimensions instead.
                img_byte_arr = io.BytesIO()
                input_image.save(img_byte_arr, exif=exif, **save_kwargs)
                if img_byte_arr.tell() <= target_bytes:
                    best_bytes = img_byte_arr.getvalue()
                else:
                    low_scale = 0.1
                    high_scale = 1.0
                    for _ in range(6):
                        scale = (low_scale + high_scale) / 2
                        w = max(1, int(input_image.width * scale))
                        h = max(1, int(input_image.height * scale))
                        resized_img = input_image.resize((w, h), Image.Resampling.LANCZOS)
                        img_byte_arr = io.BytesIO()
                        resized_img.save(img_byte_arr, exif=exif, **save_kwargs)
                        size = img_byte_arr.tell()
                        if size <= target_bytes:
                            best_bytes = img_byte_arr.getvalue()
                            low_scale = scale
                        else:
                            high_scale = scale
                
                if best_bytes is None:
                    # Fallback to minimum scale
                    w = max(1, int(input_image.width * 0.1))
                    h = max(1, int(input_image.height * 0.1))
                    resized_img = input_image.resize((w, h), Image.Resampling.LANCZOS)
                    img_byte_arr = io.BytesIO()
                    resized_img.save(img_byte_arr, exif=exif, **save_kwargs)
                    best_bytes = img_byte_arr.getvalue()
                output_bytes = best_bytes
            else:
                low_q = 5
                high_q = quality
                for _ in range(6):
                    q = (low_q + high_q) // 2
                    save_kwargs["quality"] = q
                    img_byte_arr = io.BytesIO()
                    
                    temp_img = input_image
                    if out_fmt == 'jpeg' and temp_img.mode in ('RGBA', 'LA'):
                        temp_img = temp_img.convert("RGB")
                        
                    temp_img.save(img_byte_arr, exif=exif, **save_kwargs)
                    size = img_byte_arr.tell()
                    if size <= target_bytes:
                        best_bytes = img_byte_arr.getvalue()
                        low_q = q + 1
                    else:
                        high_q = q - 1

                if best_bytes is None:
                    save_kwargs["quality"] = 5
                    img_byte_arr = io.BytesIO()
                    temp_img = input_image
                    if out_fmt == 'jpeg' and temp_img.mode in ('RGBA', 'LA'):
                        temp_img = temp_img.convert("RGB")
                    temp_img.save(img_byte_arr, exif=exif, **save_kwargs)
                    best_bytes = img_byte_arr.getvalue()
                
                output_bytes = best_bytes
        else:
            img_byte_arr = io.BytesIO()
            temp_img = input_image
            if out_fmt == 'jpeg' and temp_img.mode in ('RGBA', 'LA'):
                temp_img = temp_img.convert("RGB")
            temp_img.save(img_byte_arr, exif=exif, **save_kwargs)
            output_bytes = img_byte_arr.getvalue()

        media_type = f"image/{out_fmt}"
        if out_fmt == "jpeg":
            media_type = "image/jpeg"

        return Response(content=output_bytes, media_type=media_type)

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
