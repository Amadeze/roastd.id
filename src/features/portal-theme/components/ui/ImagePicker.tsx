// =============================================================================
// IMAGE PICKER — Upload or enter URL for images
// =============================================================================

"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { Upload, X } from "lucide-react";

interface ImagePickerProps {
  value: string;
  onChange: (url: string) => void;
}

export function ImagePicker({ value, onChange }: ImagePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (data.success) {
        onChange(data.url);
      }
    } catch {
      // Upload failed silently
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      {value && (
        <div className="relative group">
          <Image
            src={value}
            alt="Preview"
            width={800}
            height={200}
            className="h-20 w-full rounded-lg object-cover"
            unoptimized
          />
          <button
            onClick={() => onChange("")}
            className="absolute top-1 right-1 rounded-full bg-red-500 p-1 text-white opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Image URL"
          className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900"
        />
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileUpload}
        />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={isUploading}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50"
        >
          <Upload size={16} />
        </button>
      </div>
    </div>
  );
}
