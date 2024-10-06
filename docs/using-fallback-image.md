# Using the FallbackImage Component

To address issues with loading images from remote sources, particularly the Cloudflare IPFS gateway, we've implemented a `FallbackImage` component. This component provides error handling and fallback functionality for images that fail to load.

## How to Use

1. Import the FallbackImage component in your file:

```typescript
import FallbackImage from '@/components/ui/fallback-image';
```

2. Replace existing `Image` components from 'next/image' with `FallbackImage`:

```typescript
// Before
import Image from 'next/image';

// ...

<Image src={imageUrl} alt="Description" width={100} height={100} />

// After
import FallbackImage from '@/components/ui/fallback-image';

// ...

<FallbackImage src={imageUrl} alt="Description" width={100} height={100} fallbackSrc="/path/to/fallback-image.jpg" />
```

3. The `fallbackSrc` prop is optional. If not provided, it will default to '/placeholder-user.jpg'.

## Example

```typescript
import FallbackImage from '@/components/ui/fallback-image';

const ProfileImage = ({ imageUrl, userName }) => {
  return (
    <FallbackImage
      src={imageUrl}
      alt={`Profile picture of ${userName}`}
      width={64}
      height={64}
      fallbackSrc="/default-avatar.png"
    />
  );
};
```

By using the `FallbackImage` component, you ensure that even if the primary image fails to load (due to network issues or other problems), a fallback image will be displayed instead of a broken image placeholder.

Remember to update all instances where remote images are used, especially those fetched from the Cloudflare IPFS gateway or other potentially unreliable sources.