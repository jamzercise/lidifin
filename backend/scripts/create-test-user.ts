import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
    const username =
        process.env.LIDIFIN_TEST_USERNAME ||
        process.env.LIDIFY_TEST_USERNAME ||
        "predeploy";
    const password =
        process.env.LIDIFIN_TEST_PASSWORD ||
        process.env.LIDIFY_TEST_PASSWORD ||
        "predeploy-password";

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.upsert({
        where: { username },
        update: { passwordHash },
        create: {
            username,
            passwordHash,
            onboardingComplete: true,
        },
    });

    console.log(`Test user ready: ${user.username}`);
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
