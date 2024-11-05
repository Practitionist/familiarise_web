import React, { useState } from "react";
import Image, { ImageProps } from "next/image";

interface FallbackImageProps extends Omit<ImageProps, "onError"> {
  fallbackSrc?: string;
}

const FallbackImage: React.FC<FallbackImageProps> = ({
  src,
  fallbackSrc,
  alt,
  ...rest
}) => {
  const [imgSrc, setImgSrc] = useState(src);

  const handleError = () => {
    setImgSrc(fallbackSrc || "/placeholder-user.jpg"); // Use the provided fallback or a default placeholder
  };

  return <Image {...rest} src={imgSrc} alt={alt} onError={handleError} />;
};

export default FallbackImage;
