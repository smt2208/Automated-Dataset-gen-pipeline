# Use an official Python runtime as a parent image
FROM python:3.11-slim

# Set the working directory
WORKDIR /app

# Install OS-level dependencies for PyMuPDF and Tesseract OCR (with Bengali support)
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-ben \
    libmupdf-dev \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy the requirements file into the container
COPY requirements.txt .

# Install any python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the backend files
COPY . .

# Expose the port that FastAPI runs on (Render provides PORT env var)
EXPOSE 8000

# Command to run the application (Render will bind to host 0.0.0.0 and process.env.PORT)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
