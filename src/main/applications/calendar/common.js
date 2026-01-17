import { z } from 'zod';


const CalendarItemSchema = z.object({
    uid: z.string(),
    subject: z.string(),
    startTime: z.number(),
    endTime: z.number(),
    location: z.string().default('')
});

export { CalendarItemSchema };