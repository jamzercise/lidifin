import { prisma } from "../utils/db";
import { rssParserService } from "./rss-parser";

/**
 * Refresh a single podcast feed — used by GET /podcasts/:id/refresh and the
 * enrichment worker's automatic refresh phase.
 */
export async function refreshPodcastFeed(podcastId: string): Promise<{
    newEpisodesCount: number;
    totalEpisodes: number;
}> {
    const podcast = await prisma.podcast.findUnique({
        where: { id: podcastId },
    });
    if (!podcast) throw new Error(`Podcast ${podcastId} not found`);

    const { podcast: podcastData, episodes } = await rssParserService.parseFeed(
        podcast.feedUrl,
    );

    await prisma.podcast.update({
        where: { id: podcastId },
        data: {
            title: podcastData.title,
            author: podcastData.author,
            description: podcastData.description,
            imageUrl: podcastData.imageUrl,
            language: podcastData.language,
            explicit: podcastData.explicit || false,
            episodeCount: episodes.length,
            lastRefreshed: new Date(),
        },
    });

    let newEpisodesCount = 0;
    for (const ep of episodes) {
        const existing = await prisma.podcastEpisode.findUnique({
            where: { podcastId_guid: { podcastId, guid: ep.guid } },
        });

        if (!existing) {
            await prisma.podcastEpisode.create({
                data: {
                    podcastId,
                    guid: ep.guid,
                    title: ep.title,
                    description: ep.description,
                    audioUrl: ep.audioUrl,
                    duration: ep.duration,
                    publishedAt: ep.publishedAt,
                    episodeNumber: ep.episodeNumber,
                    season: ep.season,
                    imageUrl: ep.imageUrl,
                    fileSize: ep.fileSize,
                    mimeType: ep.mimeType,
                },
            });
            newEpisodesCount++;
        }
    }

    return { newEpisodesCount, totalEpisodes: episodes.length };
}
