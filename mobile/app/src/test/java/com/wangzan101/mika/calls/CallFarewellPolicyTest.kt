package com.wangzan101.mika.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 什么时候算「这通电话可以说再见了」。
 *
 * 这条规则决定 AI 会不会自己挂断。判早了就是半路挂断用户的电话,
 * 判晚了电话一直挂着。所以两边都要测:该挂的要认出,不该挂的一个都不能误判。
 */
class CallFarewellPolicyTest {

    // ---- 该认出来的收尾 ----

    @Test fun plainGoodbyesAreClosings() {
        for (s in listOf("再见", "拜拜", "再见了", "拜拜啦", "好的再见", "那好,再见", "嗯嗯,再见")) {
            assertTrue("该认出收尾: [$s]", CallFarewellPolicy.isExplicitCallerFarewell(s))
        }
    }

    @Test fun sayingTheyWillHangUpIsAClosing() {
        // 主语必须在:光说「先挂了吧」说不清是谁挂,实现按保守处理
        for (s in listOf("那我们先挂了", "我挂了", "我这边就先挂了", "那我挂了啊")) {
            assertTrue("该认出收尾: [$s]", CallFarewellPolicy.isExplicitCallerFarewell(s))
        }
    }

    @Test fun askingTheAssistantToHangUpIsAClosing() {
        for (s in listOf("麻烦你挂断吧", "请帮我挂一下电话", "你可以挂了", "可以挂断了", "可以结束通话了")) {
            assertTrue("该认出收尾: [$s]", CallFarewellPolicy.isExplicitCallerFarewell(s))
        }
    }

    @Test fun thanksThenGoodbyeIsStillAClosing() {
        for (s in listOf("谢谢啊,再见", "辛苦了,拜拜", "多谢,再见")) {
            assertTrue("该认出收尾: [$s]", CallFarewellPolicy.isExplicitCallerFarewell(s))
        }
    }

    /**
     * 已知的覆盖不足(不是误判,是漏判):「好的」和「辛苦了」连成一句、中间没有标点时认不出来。
     * 实测 `好的辛苦了,拜拜` / `好的谢谢,拜拜` 都是 false,而加个逗号的 `好的,辛苦了,拜拜` 是 true。
     * 原因:判定按标点分句,`好的辛苦了` 这一句里 COURTESY 只能吃到「好的」,剩下的「辛苦了」
     * 既不在收尾词表前段的允许范围,也没被认成致谢。
     *
     * 保守方向是对的(漏判只会让电话多挂一会儿,误判会半路挂断),所以不改实现,
     * 把行为固定下来:哪天要放宽,先让这一条红。
     */
    @Test fun aRunOnAcknowledgementPlusThanksIsNotRecognized() {
        for (s in listOf("好的辛苦了,拜拜", "好的辛苦,拜拜", "好的谢谢,拜拜", "好辛苦了,拜拜")) {
            assertFalse("目前认不出来的连写,改了就会红: [$s]", CallFarewellPolicy.isExplicitCallerFarewell(s))
        }
        // 加了标点就能认
        for (s in listOf("好的,辛苦了,拜拜", "好的,谢谢,再见")) {
            assertTrue("分开就认得出来: [$s]", CallFarewellPolicy.isExplicitCallerFarewell(s))
        }
    }

    // ---- 绝不能误判成收尾 ----

    /**
     * 「就这样吧」单独出现不是告别:它常是「这事就这么办吧」。
     * 只有带着明确的告别词才算。这是最要紧的一条,错判就是半路挂断。
     */
    @Test fun aBareAcknowledgementIsNotAFarewell() {
        for (s in listOf("好", "好的", "嗯", "嗯嗯", "行", "行吧", "好吧", "可以", "知道了", "明白了")) {
            assertFalse("不该当成告别: [$s]", CallFarewellPolicy.isExplicitCallerFarewell(s))
        }
    }

    @Test fun questionsAreNeverFarewells() {
        for (s in listOf("你说什么?", "可以再问一个吗？", "那就这样好吗?", "能帮我挂断吗?")) {
            assertFalse("问了话就不是告别: [$s]", CallFarewellPolicy.isExplicitCallerFarewell(s))
        }
    }

    /** 引号里的话是在转述或模仿别人说,不能当成对方真的要挂。 */
    @Test fun quotedSpeechIsNotAFarewell() {
        for (s in listOf(
            "他说「再见」", "我说\"拜拜\"了", "对方说了“挂了吧”",
            "可以这样说:再见", "你跟我念一遍:再见",
        )) {
            assertFalse("引述/示范不是告别: [$s]", CallFarewellPolicy.isExplicitCallerFarewell(s))
        }
    }

    /** 提到别人要挂电话,不是自己要挂。 */
    @Test fun talkingAboutSomeoneElseHangingUpIsNotAClosing() {
        for (s in listOf("刚才那个人说他先挂了", "他说他挂了", "上次他们说要挂断")) {
            assertFalse("说的是别人: [$s]", CallFarewellPolicy.isExplicitCallerFarewell(s))
        }
    }

    @Test fun emptyAndOverlongInputIsNotAClosing() {
        assertFalse(CallFarewellPolicy.isExplicitCallerFarewell(""))
        assertFalse(CallFarewellPolicy.isExplicitCallerFarewell("   "))
        assertFalse("超长的一段话不该判成告别", CallFarewellPolicy.isExplicitCallerFarewell("再" + "见".repeat(200)))
    }

    // ---- AI 自己那句收尾 ----

    @Test fun theAssistantMayCloseWithASettledEnding() {
        for (s in listOf("那就先这样", "那就这样吧", "好的,那就先这样", "先这样吧", "不打扰您了", "祝您生活愉快")) {
            assertTrue("该认出收尾: [$s]", CallFarewellPolicy.isAssistantClosing(s))
        }
    }

    /** AI 那句话里带问号、引号或转述,都不是收尾:它还在办事。 */
    @Test fun theAssistantIsNotClosingWhileAsking() {
        for (s in listOf(
            "那还需要我帮您问别的吗?", "您可以这样说:\"我想预约\"",
            "例如说「明天上午」", "好的，那就这样吧？",
        )) {
            assertFalse("还在办事,不是收尾: [$s]", CallFarewellPolicy.isAssistantClosing(s))
        }
    }

    /** 只有最后一个短句决定是不是收尾:前面说了多少都不影响。 */
    @Test fun onlyTheLastClauseDecides() {
        assertTrue(CallFarewellPolicy.isAssistantClosing("已经帮您确认过了,是周三上午十点,那就先这样吧"))
        assertFalse(CallFarewellPolicy.isAssistantClosing("那就先这样吧,不过还有一件事要问您"))
    }
}
