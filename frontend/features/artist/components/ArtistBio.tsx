import DOMPurify from "dompurify";

interface ArtistBioProps {
  bio: string;
}

export function ArtistBio({ bio }: ArtistBioProps) {
  if (!bio) return null;

  return (
    <section>
      <h2 className="text-xl font-bold mb-4">About</h2>
      <div className="bg-white/5 rounded-md p-4">
        <div
          className="prose prose-sm md:prose-base prose-invert max-w-none leading-relaxed [&_a]:text-[#B1D2C3] [&_a]:no-underline [&_a:hover]:underline"
          style={{ color: '#b3b3b3' }}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(bio || "") }}
        />
      </div>
    </section>
  );
}
