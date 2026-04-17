# Use an official Python runtime as a parent image
FROM python:3.11-slim

# Set the working directory to the root of our app
WORKDIR /app

# Install OS-level dependencies for PyMuPDF and Tesseract OCR (with Bengali support)
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-ben \
    libmupdf-dev \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy ONLY backend requirements first to leverage Docker layer caching
COPY backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r backend/requirements.txt

# Copy everything else (both frontend and backend folders) into the container
COPY . .

# Move into the backend folder where the FastAPI code lives
WORKDIR /app/backend

# Expose the port that FastAPI runs on
EXPOSE 8000

# Command to run the application (Render will bind to host 0.0.0.0 automatically)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
