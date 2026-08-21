# Image Tool API (FastAPI + rembg)

This is a standalone python microservice providing AI-powered background removal and cropping. You can run it locally or host it on a server, and configure your Chrome Extension options to use it.

## Features
- High-quality AI background removal using `rembg` (U-2-Net model)
- Optional automated transparent margin cropping
- Fully CORS enabled for browser/extension calls

## Installation

1. Make sure you have **Python 3.8+** installed.
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Running the API

Start the service locally on port 8000:
```bash
python main.py
```
Or with uvicorn directly:
```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## API Endpoint

### `POST /remove-bg`
Removes background from an image.

**Request Body (multipart/form-data):**
- `file`: The image file binary.
- `crop` (query param, optional): `true` to auto-crop transparent edges.

**Response:**
Returns the processed transparent PNG image binary.
