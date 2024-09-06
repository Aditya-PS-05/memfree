'use server';

import { incSearchCount } from '@/lib/db';
import { getLLM, Message } from '@/lib/llm/llm';
import { getHistory, streamResponse } from '@/lib/llm/utils';
import { logError } from '@/lib/log';
import { GPT_4o_MIMI } from '@/lib/model';
import {
    getSearchEngine,
    getVectorSearch,
    IMAGE_LIMIT,
} from '@/lib/search/search';
import { saveMessages } from '@/lib/server-utils';
import { directlyAnswer } from '@/lib/tools/answer';
import { getRelatedQuestions } from '@/lib/tools/related';
import { Message as StoreMessage, SearchCategory } from '@/lib/types';

export async function knowledgeBaseSearch(
    messages: StoreMessage[],
    isPro: boolean,
    userId: string,
    onStream?: (...args: any[]) => void,
    model = GPT_4o_MIMI,
) {
    try {
        const url = messages[0].imageFile;
        const newMessages = messages.slice(-1) as Message[];
        const query = newMessages[0].content;

        await streamResponse({ status: 'Searching ...' }, onStream);

        const imageFetchPromise = getSearchEngine({
            categories: [SearchCategory.IMAGES],
        })
            .search(query)
            .then((results) =>
                results.images
                    .filter((img) => img.image.startsWith('https'))
                    .slice(0, IMAGE_LIMIT),
            );

        const { texts } = await getVectorSearch(userId, url).search(query);

        if (texts.length > 0) {
            await streamResponse(
                { sources: texts, status: 'Thinking ...' },
                onStream,
            );
        } else {
            const answer = `#### No relevant content in your Knowledge Base
#### Please indexing your Knowledge Base first
#### MemFree now supports indexing local files, web pages, and browser bookmarks.
#### You can also choose All search source`;
            await streamResponse({ answer: answer }, onStream);
            await saveMessages(userId, messages, answer);
            onStream?.(null, true);
        }

        let history = getHistory(isPro, messages);
        let fullAnswer = '';
        let rewriteQuery = query;

        const source = SearchCategory.ALL;
        await streamResponse({ status: 'Answering ...' }, onStream);
        await directlyAnswer(
            isPro,
            source,
            history,
            '',
            getLLM(model),
            rewriteQuery,
            texts,
            (msg) => {
                fullAnswer += msg;
                onStream?.(
                    JSON.stringify({
                        answer: msg,
                    }),
                );
            },
        );

        const fetchedImages = await imageFetchPromise;
        const images = [...fetchedImages];
        await streamResponse(
            { images: images, status: 'Generating related questions ...' },
            onStream,
        );

        let fullRelated = '';
        await getRelatedQuestions(rewriteQuery, texts, (msg) => {
            fullRelated += msg;
            onStream?.(JSON.stringify({ related: msg }));
        });

        incSearchCount(userId).catch((error) => {
            console.error(
                `Failed to increment search count for user ${userId}:`,
                error,
            );
        });

        await saveMessages(
            userId,
            messages,
            fullAnswer,
            texts,
            images,
            fullRelated,
        );
        onStream?.(null, true);
    } catch (error) {
        logError(error, 'knowledge-base-search');
        onStream?.(null, true);
    }
}