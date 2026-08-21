import io
import uvicorn
from fastapi import FastAPI, File, UploadFile, Query, HTTPException
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

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
